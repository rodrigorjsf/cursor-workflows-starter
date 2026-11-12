// Motor do runtime: executa um WorkflowDefinition com agentes do Cursor SDK.
//
// Garantias que o motor dá (e que skills/subagents não dão):
//  - A ordem, os ramos e os laços estão no código; o modelo não decide se uma etapa roda.
//  - Cada agent() termina com resultado validado ou lança erro (após retries) — nada é "pulado" em silêncio.
//  - Modelo por etapa. O SDK valida o ID contra o catálogo da conta no Agent.create (ConfigurationError "Cannot use
//    this model") e a etapa falha. RunResult.model traz o ID resolvido (alias → catálogo), registrado no step-end;
//    com `default` (Auto) a rota do Router não aparece. Política de modelo do admin não foi testada.
//  - Teto de custo/tokens por run; RateLimitError não retentável (teto de uso do plano, segundo a doc) aborta com mensagem clara.
//  - Journal para retomar sem repetir etapas concluídas.
//
// STATUS: verificado contra a API real num plano Premium em 2026-11-11 (docs/research/verificacoes-locais.md).

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection, RunUsage, SettingSource } from "@cursor/sdk";
import { Ajv } from "ajv";
import { type AgentBackend, type AttemptEvent, type AttemptResult, type StepLocation, type StepOptions, type UsageReading, localBackend } from "./backend.js";
import { createCloudBackend } from "./backend-cloud.js";
import { type CommandOutcome, EXEC_FLUSH_MS, EXEC_LOG_MAX_CHARS, outputLog, runCommand, toExecResult } from "./command-runner.js";
import { ConfigError, STEP_OVERRIDE_FIELDS, type LimitOverrides, type ResolvedConfig, type StepOverrides, allowedSources, isModelAllowed, loadEffectiveConfig } from "../config/index.js";
import { type ContentKind, EVENT_SCHEMA_VERSION, type ErrorKind, type OutputStream, type NewEvent, type RunStatus, type StepRef, type TurnUsage, type WorkflowEvent } from "./events.js";
import { MemoStore, isReadOnly, repoState } from "./memo.js";
import { type InterruptedCloudStep, addUsage, emptyUsage, resumeHint, subtractUsage, turnTokens, withRatio } from "./projection.js";
import { CONTENT_MAX_CHARS, RunLockedError, RunStore } from "./run-store.js";
import type { RetentionPolicy } from "./retention.js";
import { registerRun } from "./runs-index.js";
import { stateDir as runtimeStateDir } from "./state.js";
import type { AgentCallOptions, Budget, ExecOptions, ExecResult, UsageTotals, WorkflowContext, WorkflowDefinition } from "./workflow.js";
import { workflowSourceHash } from "./workflow-source.js";
import { type Snapshot, revertToSnapshot, takeSnapshot } from "./worktree-snapshot.js";

export type { ErrorKind, RunStatus, TurnUsage, WorkflowEvent } from "./events.js";

/** Erro que encerra o run inteiro, inclusive dentro de parallel/pipeline (não vira null). */
export class FatalRunError extends Error {}
export class BudgetExceededError extends FatalRunError {}
/** A conta não tem acesso ao SDK (ex.: plano Free: `plan_required` já no Agent.create). Tentar de novo não adianta. */
export class AccountAccessError extends FatalRunError {}
export class StepFailedError extends Error {}
/** A step crossed its own token cap (`maxTokensPerStep`): the step fails with no retry, the run goes on. */
export class StepBudgetError extends StepFailedError {}
/** How long a run that hit its token cap waits for the steps it cancelled to finish their accounting before it ends. */
const CANCEL_GRACE_MS = 30_000;

/**
 * The "stop this attempt now" switch of one attempt. Everything that ends an attempt early goes through its signal, which
 * the backend honours: the run's cancellation, the step's timeout and a crossed token cap. The first cause wins and is the
 * signal's reason, which the backend reports back. `cut(err)` is the token-cap cause: `isCutBy` tells it from the others.
 * (`cutters` below is how a turn of one step cuts the other steps' attempts.)
 */
class AttemptAbort {
  private readonly controller = new AbortController();
  private cutError: Error | undefined;
  private agentExists = false;
  readonly signal = this.controller.signal;

  /** Ends the attempt for a reason of the run or the step (cancellation, timeout). A no-op once the attempt is aborted. */
  abort(reason: Error): void {
    this.controller.abort(reason);
  }

  /**
   * Ends the attempt because a token cap was crossed; the first cap wins. A cap never abandons an agent that is still being
   * created: it waits until the backend reports the agent, so the agent is stopped and its usage counted.
   */
  cut(err: Error): void {
    if (this.signal.aborted || this.cutError) return;
    this.cutError = err;
    if (this.agentExists) this.controller.abort(err);
  }

  /** The backend has an agent (it said so, or it reported something only an agent does): applies a cut held back until now. */
  agentReady(): void {
    this.agentExists = true;
    if (this.cutError && !this.signal.aborted) this.controller.abort(this.cutError);
  }

  isCutBy(reason: unknown): boolean {
    return this.cutError !== undefined && reason === this.cutError;
  }
}
/** The step's time ran out (the attempt's creation, send and wait share it): the abort reason of a timed-out attempt. */
class StepTimeoutError extends StepFailedError {}
/**
 * The run was cancelled (`RunOptions.signal` aborted). It ends the whole run, also inside parallel/pipeline: active steps
 * stop and no step starts. The run is resumable with the same id.
 */
export class RunCancelledError extends FatalRunError {}

/**
 * Marca o ambiente do processo: o shell das etapas herda (o CLI recusa `wf run/start`). Os servidores MCP do
 * .cursor/mcp.json NÃO herdam (medido); para eles o engine registra o guarda inline de `nestedGuard`.
 */
export const INSIDE_WORKFLOW_ENV = "WF_INSIDE_WORKFLOW";

/** Nome do servidor MCP do kit no mcp.json do projeto (o default é o do kit). */
const WORKFLOWS_MCP_NAME = process.env.WF_MCP_SERVER_NAME ?? "workflows";

/**
 * Servidor inline, sem tools, que substitui o `workflows` do projeto dentro das etapas. O SDK sobe os servidores do
 * .cursor/mcp.json sem repassar o ambiente do processo, então WF_INSIDE_WORKFLOW não chega até eles (medido).
 * Só é preciso quando a etapa carrega camadas de arquivo (project, user, plugins ou all).
 */
function withGuard<T extends object>(guard: Record<string, unknown>, own: T | undefined): T | undefined {
  const merged = { ...guard, ...own } as T;
  return Object.keys(merged).length ? merged : undefined;
}

function nestedGuard(sources: SettingSource[]): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  if (!sources.some((s) => s === "project" || s === "user" || s === "plugins" || s === "all")) return {};
  const script = fileURLToPath(new URL("./nested-mcp-guard.mjs", import.meta.url));
  return { [WORKFLOWS_MCP_NAME]: { command: process.execPath, args: [script], env: { [INSIDE_WORKFLOW_ENV]: "1" } } };
}

export interface RunOptions {
  /** Diretório do repositório onde os agentes trabalham. */
  cwd: string;
  /** Chave do usuário (ou service account). Se omitida, o SDK usa CURSOR_API_KEY e depois o login salvo. */
  apiKey?: string;
  /** Id do run. Para retomar, passe o id de um run anterior (o journal evita repetir etapas concluídas). */
  runId?: string;
  /** The job executing this run (`wf start`, `start_workflow`). It goes in the `run-start`, and a job's state is the projection of the execution that carries its id. */
  jobId?: string;
  /**
   * `maxCents`, `maxTokens` and `concurrency` are the flag layer of the config (CLI flags, or whoever embeds the engine):
   * above the env and the config files, below the global caps. `null` turns the limit off (the caps still apply).
   * `maxCents` is the cost cap for the whole run, earlier executions (resumes) included: passed to a resume, it is the
   * new total cap.
   */
  maxCents?: number | null;
  /** Token cap for the whole run, with the same rule as `maxCents`. */
  maxTokens?: number | null;
  /** Agentes simultâneos. Default 4 (o Cursor não documenta limite numérico; seja conservador). */
  concurrency?: number;
  /** The chat's overrides (`start_workflow`): they can only tighten the resolved limits; a looser one is a violation and has no effect. */
  mcpOverrides?: LimitOverrides;
  /**
   * Camadas de configuração carregadas pelos agentes das etapas. Default ["project","team","mdm"]:
   * AGENTS.md, .cursor/rules, skills (.agents/skills, .cursor/skills, ...), hooks e MCP do projeto,
   * mais regras/hooks do time e hooks Enterprise (MDM). Remova "project" em repositórios não confiáveis.
   */
  settingSources?: SettingSource[];
  /** Onde ficam journal e estado. Default <cwd>/.workflows/runs. */
  stateDir?: string;
  /**
   * How long step content stays in the repo's event logs (default: the last 30 runs or 14 days). When the run starts, the
   * `text` of the `content` events of runs outside the retention is deleted; the rest of the log stays. A `null` limit
   * turns that limit off.
   */
  retention?: RetentionPolicy;
  /**
   * Aborting it cancels the run (`wf cancel`, `cancel_workflow`, SIGINT and SIGTERM all end up here): the active agent runs
   * are cancelled, the in-flight write step is reverted to its state before the step, no new step starts, and the run ends
   * with status `cancelled`. The run stays resumable: its completed steps are in the journal.
   */
  signal?: AbortSignal;
  onEvent?: (e: WorkflowEvent) => void;
  /**
   * Where the steps' agents run: every attempt of a step goes through a backend (see `AgentBackend` in `backend.ts` for the
   * contract). This one serves the steps of its own `location`; the steps of the other location use the default backend of
   * theirs: the local one is the SDK's local agents, the cloud one the SDK's cloud agents on a snapshot of the worktree.
   */
  backend?: AgentBackend;
  /**
   * Banco de métricas (SQLite). Default: ~/.cursor-workflows/metrics.db ($WF_METRICS_DB). `false` desliga;
   * WF_METRICS=off também. Falha ao gravar métricas nunca derruba o workflow.
   */
  metricsDb?: string | false;
}

export interface RunOutcome<R> {
  runId: string;
  status: RunStatus;
  result?: R;
  error?: string;
  /** true when the runtime refused the run before it started (invalid args, run already executing): nothing was written to the log. */
  refused?: true;
  /** Custo do Cursor que o teto usa: soma, por tentativa, do maior entre `rawCostCents` e `chargedCents`. Acumula entre resumes do run. */
  spentCents: number;
  /** Soma de `chargedCents` (o valor cobrado; 0 para uso incluído no plano, BYOK e créditos). */
  chargedCents: number;
  spentTokens: number;
  /** Tokens por tipo. O input já inclui o cache (medido); cacheHitRatio = cacheRead / input (ver docs/operating/02-custos-e-cache.md). */
  usage: UsageTotals & { cacheHitRatio: number | null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves when every promise has settled, or after `ms`, whichever comes first. */
async function settledWithin(promises: Promise<unknown>[], ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([Promise.allSettled(promises), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
const ajv = new Ajv({ allErrors: true, strict: false });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Opens an execution of the run in its log: the run-start event with the effective config, then the warnings an
 * execution starts with (config violations, metrics off, workflow code changed since the last execution, old content
 * that could not be pruned, a torn last line). Registers a first execution in the global runs index.
 */
function announceRun<A>(o: {
  def: WorkflowDefinition<A, any>;
  args: A;
  opts: RunOptions;
  runId: string;
  store: RunStore;
  resolved: ResolvedConfig;
  emit: (e: NewEvent) => void;
  recorderWarning: string | undefined;
  /** The repository the run is in (`repoIdentity`). */
  repo: { name: string; hash: string };
}): void {
  const { def, args, opts, runId, store, resolved, emit, recorderWarning } = o;
  // The source fingerprint covers the modules the workflow imports (prompts, helpers); `run.toString()` alone does not.
  const workflowHash = sha(JSON.stringify(def.meta) + JSON.stringify(def.defaults ?? {}) + def.run.toString() + (workflowSourceHash(def) ?? "")).slice(0, 16);
  const startedAt = new Date().toISOString();
  const pruned = store.pruneOldContent(opts.retention);
  emit({
    type: "run-start",
    workflow: def.meta.name,
    workflowHash,
    argsHash: sha(JSON.stringify(args ?? null)).slice(0, 16),
    repo: o.repo,
    phases: def.meta.phases?.map((p) => p.title),
    jobId: opts.jobId,
    config: resolved.config,
    provenance: resolved.provenance,
    violations: resolved.violations,
  });
  for (const v of resolved.violations) emit({ type: "warning", message: `config: ${v.message} (${v.ref ?? v.layer}${v.path ? ` ${v.path}` : ""})` });
  if (recorderWarning) emit({ type: "warning", message: recorderWarning });
  if (store.previousStart && store.previousStart.workflowHash !== workflowHash) {
    emit({
      type: "warning",
      message: `the workflow code changed since this run's previous execution (${store.previousStart.workflowHash} → ${workflowHash}): the resumed run mixes versions`,
    });
  }
  if (!store.previousStart) {
    // First execution of this run: register it where tools outside the repo can find it. A resume is the same run.
    try {
      registerRun({ runId, repo: resolve(opts.cwd), workflow: def.meta.name, startedAt });
    } catch (err) {
      emit({ type: "warning", message: `could not register the run in the global runs index: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  for (const { runId: prunedRun, error } of pruned.failed) {
    emit({ type: "warning", message: `could not delete the old content of run ${prunedRun}: ${error}` });
  }
  if (store.tornTail.events) emit({ type: "warning", message: "the last line of the event log was incomplete (a crash in the middle of a write): ignored" });
  if (store.tornTail.journal) emit({ type: "warning", message: "the last line of the journal was incomplete (a crash in the middle of a write): its step runs again" });
}

/** What puts a write step's directory back as it was before the step. Neither function throws; each returns true when it did. */
interface StepReverter {
  /** The run was cancelled in the middle of the step. Once: the first call reverts, later calls share its answer. */
  onCancel(): Promise<boolean>;
  /** An attempt failed and the step is retried (`revertOnRetry`). Every call reverts, back to the start of the step. */
  beforeRetry(): Promise<boolean>;
}

/** Reverts run one at a time: two steps writing in the same directory must not restore it at once. */
class RevertQueue {
  private tail: Promise<unknown> = Promise.resolve();

  forStep(o: { writes: boolean; snapshot: Snapshot | undefined; stepCwd: string; label: string; warn: (message: string) => void }): StepReverter {
    const revert = (why: string): Promise<boolean> => {
      if (!o.writes) return Promise.resolve(false);
      const run = this.tail.then(async () => {
        if (!o.snapshot) {
          o.warn(`step "${o.label}" ${why}: ${o.stepCwd} is not a git repository (or git failed), so the step's changes were not undone`);
          return false;
        }
        try {
          await revertToSnapshot(o.snapshot);
          return true;
        } catch (err) {
          o.warn(`step "${o.label}" ${why}: could not undo the changes in ${o.stepCwd}: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      });
      this.tail = run;
      return run;
    };
    let cancelled: Promise<boolean> | undefined;
    return { onCancel: () => (cancelled ??= revert("cancelled")), beforeRetry: () => revert("failed and is retried") };
  }
}

/** The run's event output: where every event goes, and how an attempt's full content is written. */
interface EventChannel {
  /** Stamps, redacts and appends an event, then hands it to the metrics recorder and the `onEvent` listener. */
  emit(e: NewEvent): void;
  attemptContent(ref: StepRef, attemptId: string): AttemptContent;
  /** Why metrics are off for this run, if they failed to start: reported after run-start. */
  recorderWarning: string | undefined;
  close(): void;
}

interface AttemptContent {
  write(kind: ContentKind, raw: string, extra?: { tool?: string; callId?: string; stream?: OutputStream }): void;
  /** Adds a piece of what the agent is saying. */
  say(delta: string): void;
  /** Writes what the agent said since the last flush as one message. */
  flush(): void;
}

async function openEventChannel(store: RunStore, runId: string, opts: RunOptions): Promise<EventChannel> {
  // Métricas: o recorder é carregado só se ligado (importa node:sqlite sob demanda).
  let recorder: { record(e: WorkflowEvent): void; close(): void } | undefined;
  let recorderWarning: string | undefined;
  if (opts.metricsDb !== false && process.env.WF_METRICS !== "off") {
    try {
      const { createRecorder } = await import("../observability/recorder.js");
      recorder = await createRecorder(opts.metricsDb || undefined);
    } catch (err) {
      recorderWarning = `metrics off: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Every event is stamped and redacted here, once: the log, the recorder and the listeners all get the same redacted event.
  const stamp = (e: NewEvent): WorkflowEvent => store.redact({ v: EVENT_SCHEMA_VERSION, ts: new Date().toISOString(), runId, ...e } as WorkflowEvent);
  let logFailed = false;
  const append = (event: WorkflowEvent) => {
    try {
      store.appendEvent(event);
    } catch (err) {
      if (logFailed) return;
      logFailed = true; // one warning only: the log is the source of truth, but a full disk must not take the run down
      opts.onEvent?.(stamp({ type: "warning", message: `could not write the event log: ${err instanceof Error ? err.message : String(err)}` }));
    }
  };
  const emit = (e: NewEvent) => {
    const event = stamp(e);
    append(event);
    try {
      recorder?.record(event);
    } catch (err) {
      const warning = stamp({ type: "warning", message: `could not write a metric: ${err instanceof Error ? err.message : String(err)}` });
      append(warning);
      opts.onEvent?.(warning);
    }
    opts.onEvent?.(event);
  };
  /**
   * The content of one attempt (prompts, what the agent said, tool calls, command output). It goes to the event log only:
   * not to the metrics recorder, not to `onEvent` listeners. Agent text arrives in deltas and is written one message per turn.
   */
  const attemptContent = (ref: StepRef, attemptId: string): AttemptContent => {
    const write = (kind: ContentKind, raw: string, extra: { tool?: string; callId?: string; stream?: OutputStream } = {}) => {
      const { text, chars, truncated } = store.prepareContent(raw);
      append(stamp({ type: "content", ...ref, attemptId, kind, ...extra, text, chars, truncated: truncated || undefined }));
    };
    let said = "";
    return {
      write,
      say: (delta) => void (said += delta),
      flush() {
        if (!said) return;
        write("agent-message", said);
        said = "";
      },
    };
  };
  return { emit, attemptContent, recorderWarning, close: () => recorder?.close() };
}

/** What an attempt counts from the backend's stream of events. */
interface AttemptCounters {
  turns: number;
  steps: number;
  stepsInTurn: number;
  summaries: number;
  reprompts: number;
  toolCalls: Record<string, number>;
}

/**
 * The `onEvent` of one attempt: counts turns, steps, summaries, re-prompts and tool calls, writes the attempt's content,
 * hands each ended turn's usage to `on.turn` (which emits the turn event and enforces the live caps), each warning to
 * `on.warning` and the agent, once it exists, to `on.agent`.
 */
function attemptEvents(
  c: AttemptCounters,
  content: AttemptContent,
  on: { turn: (usage: TurnUsage) => void; warning: (message: string) => void; agent: (event: Extract<AttemptEvent, { type: "agent" }>) => void },
): (event: AttemptEvent) => void {
  return (event) => {
    switch (event.type) {
      case "agent":
        on.agent(event);
        break;
      case "warning":
        on.warning(event.message);
        break;
      case "step":
        c.steps++;
        c.stepsInTurn++;
        break;
      case "text":
        content.say(event.delta);
        break;
      case "tool-call":
        c.toolCalls[event.tool] = (c.toolCalls[event.tool] ?? 0) + 1;
        content.write("tool-call", JSON.stringify(event.args ?? null), { tool: event.tool, callId: event.callId });
        break;
      case "tool-output":
        content.write("command-output", event.output, { tool: event.tool, callId: event.callId });
        break;
      case "summary":
        c.summaries++;
        break;
      case "reprompt":
        c.reprompts++;
        content.write("prompt", event.message);
        break;
      case "turn":
        content.flush();
        if (event.usage) on.turn(event.usage);
        c.turns++;
        c.stepsInTurn = 0;
        break;
    }
  };
}

/** Modelo + params ordenados: "composer-2[reasoning_effort=low]". Esforço e contexto viram braços distintos. */
export function modelKey(m: ModelSelection | undefined): string | undefined {
  if (!m) return undefined;
  const params = [...(m.params ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((p) => `${p.id}=${p.value}`);
  return params.length || m.maxMode ? `${m.id}[${[...params, ...(m.maxMode ? ["max"] : [])].join(",")}]` : m.id;
}

/** How long each `git` that names the run's repository may take; past it the run is named after its cwd. */
const REPO_IDENTITY_TIMEOUT_MS = 10_000;

/** The repository a run is in, for its run-start event. The git runs asynchronously: a slow one never freezes the process. */
async function repoIdentity(cwd: string): Promise<{ name: string; hash: string }> {
  const git = (...a: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile("git", a, { cwd, encoding: "utf8", timeout: REPO_IDENTITY_TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
    );
  let top = cwd;
  let origin = "";
  try {
    top = await git("rev-parse", "--show-toplevel");
    origin = await git("remote", "get-url", "origin");
  } catch {
    /* sem git ou sem remote */
  }
  return { name: basename(top), hash: sha(origin || top).slice(0, 16) };
}

export function newRunId(workflow: string): string {
  return `${workflow}-${randomUUID().slice(0, 8)}`;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // O slot é entregue diretamente pelo release(): `active` não cai e sobe de novo.
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

/** The config layers' choices for a step on top of its options. A model is merged field by field (an absent `params` inherits). */
function applyOverrides(o: AgentCallOptions, overrides: StepOverrides): AgentCallOptions {
  const merged: AgentCallOptions = { ...o };
  if (overrides.model) {
    const model = { ...o.model, ...overrides.model };
    if (model.id) merged.model = model as ModelSelection;
  }
  for (const field of STEP_OVERRIDE_FIELDS) {
    if (overrides[field] !== undefined) Object.assign(merged, { [field]: overrides[field] });
  }
  return merged;
}

/** Short, stable id of a step: derived from its journal key (hash of the prompt and options + occurrence number). */
function stepIdOf(journalKey: string): string {
  const [hash = "", occurrence = "0"] = journalKey.split(":");
  return `s-${hash.slice(0, 12)}.${occurrence}`;
}

/**
 * Where the workflow code is in the run's structure. Each branch of a `parallel`/`pipeline` has its own `Flow`, tied to
 * the code running it through AsyncLocalStorage, so `agent()` knows which node it continues from without the workflow
 * saying so.
 */
interface Flow {
  /** The innermost group this flow is inside. */
  groupId: string | null;
  /** The last node (step or group) that finished in this flow: where the next one continues from. */
  last: string | null;
  /** Groups opened so far in this flow. Numbers their ids (`g1`, `g2`, ...), which therefore do not depend on timing. */
  groups: number;
  /** Prefix of the ids of the groups opened here: the path down to this branch (`g1.0.`). */
  prefix: string;
}

export async function runWorkflow<A, R>(
  def: WorkflowDefinition<A, R>,
  args: A,
  opts: RunOptions,
): Promise<RunOutcome<R>> {
  const runId = opts.runId ?? newRunId(def.meta.name);
  const refused = (error: string): RunOutcome<R> => ({ runId, status: "failed", error, refused: true, spentCents: 0, chargedCents: 0, spentTokens: 0, usage: withRatio(emptyUsage()) });

  if (def.meta.argsSchema) {
    const validate = ajv.compile(def.meta.argsSchema);
    if (!validate(args)) return refused(`invalid args: ${ajv.errorsText(validate.errors)}`);
  }

  // The config is read afresh at the start of every execution (also a resume): an edit takes effect on the next run.
  let resolved: ResolvedConfig;
  try {
    resolved = loadEffectiveConfig(def, { cwd: opts.cwd, flags: { maxTokens: opts.maxTokens, maxCents: opts.maxCents, concurrency: opts.concurrency }, mcpOverrides: opts.mcpOverrides });
  } catch (err) {
    if (err instanceof ConfigError) return refused(err.message); // nothing is written: a run with an unusable config never starts
    throw err;
  }

  let store: RunStore;
  try {
    store = RunStore.open(join(opts.stateDir ?? runtimeStateDir(opts.cwd, "runs"), runId), runId, { secrets: [opts.apiKey] });
  } catch (err) {
    if (err instanceof RunLockedError) return refused(err.message); // nothing is written: the run belongs to the other execution
    throw err;
  }
  try {
    return await executeRun(def, args, opts, runId, store, resolved);
  } finally {
    store.close();
  }
}

/** The run itself, with the run's state (`store`) already open and locked. */
async function executeRun<A, R>(
  def: WorkflowDefinition<A, R>,
  args: A,
  opts: RunOptions,
  runId: string,
  store: RunStore,
  resolved: ResolvedConfig,
): Promise<RunOutcome<R>> {
  const { caps, limits } = resolved.config;
  // spentCents = Σ max(bruto, cobrado). O cobrado sozinho é 0 para uso incluído no plano e não protegeria nada.
  // Spend starts from what the run's log already records (earlier executions, failed attempts included): the budget
  // accumulates across resumes and never restarts from zero.
  let spentCents = store.ledger.spentCents;
  let chargedCents = store.ledger.chargedCents;
  let spentTokens = store.ledger.spentTokens;
  const totals = { ...store.ledger.usage };
  const outcome = (status: RunStatus, extra: { result?: R; error?: string }): RunOutcome<R> => ({
    runId,
    status,
    ...extra,
    spentCents,
    chargedCents,
    spentTokens,
    usage: withRatio(totals),
  });

  const { emit, attemptContent, recorderWarning, close: closeEvents } = await openEventChannel(store, runId, opts);
  announceRun({ def, args, opts, runId, store, resolved, emit, recorderWarning, repo: await repoIdentity(opts.cwd) });

  process.env[INSIDE_WORKFLOW_ENV] = "1";
  const journal = store.journal;
  const memo = new MemoStore(opts.cwd);
  const sem = new Semaphore(limits.concurrency);
  const settingSources = opts.settingSources ?? ["project", "team", "mdm"];
  const roles = new Map((def.meta.roles ?? []).map((r) => [r.name, r]));
  // The backend of each location. A backend handed in through the options serves its own location; the cloud one is made on
  // first use, so a run that never goes to the cloud never touches it.
  let cloudBackend: AgentBackend | undefined;
  const backendFor = (location: StepLocation): AgentBackend => {
    if (opts.backend?.location === location) return opts.backend;
    if (location === "local") return localBackend;
    return (cloudBackend ??= createCloudBackend({ remote: resolved.config.cloud.remote, runId }));
  };
  let currentPhase: string | undefined;
  const flows = new AsyncLocalStorage<Flow>();
  const rootFlow: Flow = { groupId: null, last: null, groups: 0, prefix: "" };
  const currentFlow = () => flows.getStore() ?? rootFlow;

  /**
   * Runs the branches of a `parallel` or `pipeline` as one group: emits group-start, gives each branch its own flow and
   * emits group-end (ok=false when a fatal error aborts the group; branches still running then may emit events after it).
   */
  async function runGroup<I, O>(kind: "parallel" | "pipeline", items: I[], branch: (item: I, index: number) => Promise<O>): Promise<O[]> {
    const outer = currentFlow();
    const groupId = `${outer.prefix}g${++outer.groups}`;
    emit({ type: "group-start", groupId, kind, size: items.length, parentId: outer.last, parentGroupId: outer.groupId });
    let ok = false;
    try {
      const results = await Promise.all(
        items.map((item, index) => flows.run({ groupId, last: groupId, groups: 0, prefix: `${groupId}.${index}.` }, () => branch(item, index))),
      );
      ok = true;
      return results;
    } finally {
      emit({ type: "group-end", groupId, ok });
      outer.last = groupId; // what follows the group continues from its join
    }
  }

  const budget: Budget = {
    maxCents: limits.maxCents,
    maxTokens: limits.maxTokens,
    spentCents: () => spentCents,
    chargedCents: () => chargedCents,
    spentTokens: () => spentTokens,
    remainingCents: () => (budget.maxCents == null ? Infinity : Math.max(0, budget.maxCents - spentCents)),
    usage: () => ({ ...totals }),
  };

  // Erro de conta (ex.: plan_required): registrado aqui para nenhuma etapa enfileirada começar depois dele.
  let accountError: AccountAccessError | undefined;

  // Live token caps. `live` holds the turn totals of the attempts in flight (they join `spentTokens` when the attempt is
  // charged); `cutters` stop those attempts. Once the run's cap is crossed, `runBreach` is the run's budget error: every
  // active attempt is cut with it and no step starts after it. The steps in flight are in `inFlight` (below).
  const live = new Set<UsageTotals>();
  const cutters = new Set<AttemptAbort>();
  let runBreach: BudgetExceededError | undefined;

  const stepCapError = (step: StepContext, tokens: number) => new StepBudgetError(`Step token cap reached for step "${step.label}": ${tokens} of ${step.tokenCap}.`);

  /** Has the turn that just ended taken the run or the step over a token cap? The run's cap wins: it ends the run. */
  function tokenBreach(step: StepContext, attemptTokens: number): Error | undefined {
    if (runBreach) return runBreach;
    if (budget.maxTokens != null) {
      let total = spentTokens;
      for (const usage of live) total += usage.totalTokens;
      if (total > budget.maxTokens) return (runBreach = new BudgetExceededError(`Token cap reached: ${total} of ${budget.maxTokens}.`));
    }
    const stepTokens = step.tokens + attemptTokens;
    return step.tokenCap != null && stepTokens > step.tokenCap ? stepCapError(step, stepTokens) : undefined;
  }

  // Cancellation. `cancelled` rejects when the signal aborts; it is only ever raced against something, never awaited alone.
  const signal = opts.signal;
  const cancelMessage = `run cancelled; ${resumeHint(runId)}`;
  const cancelled = signal
    ? new Promise<never>((_, reject) => {
        const fire = () => reject(new RunCancelledError(cancelMessage));
        if (signal.aborted) fire();
        else signal.addEventListener("abort", fire, { once: true });
      })
    : undefined;
  cancelled?.catch(() => {});
  /** A step was cut short by the cancellation: whatever the workflow returns, the run did not run to its end. */
  let interrupted = false;
  /** The steps being executed. A cancelled run waits for them to stop before it ends. */
  const inFlight = new Set<Promise<unknown>>();
  /** After the cancellation, ends when every step in flight has stopped; then rejects. Lets a workflow stuck outside a step still end. */
  const abandoned = cancelled?.catch(async (err: unknown) => {
    await Promise.allSettled([...inFlight]);
    throw err;
  });
  abandoned?.catch(() => {});

  const reverts = new RevertQueue();

  function assertNotCancelled(): void {
    if (signal?.aborted) throw new RunCancelledError(cancelMessage);
  }

  function assertBudget(): void {
    if (accountError) throw accountError;
    if (runBreach) throw runBreach;
    if (budget.maxCents != null && spentCents >= budget.maxCents) {
      throw new BudgetExceededError(`Cost cap reached: ${spentCents}¢ of ${budget.maxCents}¢.`);
    }
    if (budget.maxTokens != null && spentTokens >= budget.maxTokens) {
      throw new BudgetExceededError(`Token cap reached: ${spentTokens} of ${budget.maxTokens}.`);
    }
  }

  interface Charge {
    charged: number;
    raw?: number;
    costFinal: boolean;
    usage: UsageTotals;
    reasoningTokens?: number;
    runs: RunUsage[];
  }

  /**
   * Counts what an attempt cost, from the backend's reading of the agent's usage. `turnUsage` is the sum of the attempt's
   * `turn` events: it becomes the source of the tokens when the reading failed (the SDK doc says a local agent's usage can
   * answer 403 `feature_unavailable`, depending on the account).
   */
  function chargeUsage(reading: UsageReading, turnUsage: UsageTotals & { reasoningTokens?: number }): Charge {
    const u = "report" in reading ? reading.report : undefined;
    const charged = u?.cost?.chargedCents ?? 0;
    const usage = emptyUsage();
    addUsage(usage, u ? u.usage : turnUsage);
    // O cobrado pode ficar acima do bruto (Cursor Token Fee); o bruto, acima do cobrado (uso incluído no plano).
    spentCents += Math.max(u?.cost?.rawCostCents ?? 0, charged);
    chargedCents += charged;
    spentTokens += usage.totalTokens;
    live.delete(turnUsage); // its tokens are in spentTokens now (here, not in the attempt's finally: a rate-limit backoff sleeps in between)
    if (!u) {
      const why = "failed" in reading ? reading.failed : "";
      emit({
        type: "warning",
        message: `getUsage() failed (${why.slice(0, 160)}): tokens counted from the turn-ended events; cost unknown, so the cents cap did not count this attempt. Use --max-tokens.`,
      });
    } else if (!u.cost) {
      emit({
        type: "warning",
        message: "Cursor has not reported the attempt's cost yet: the cents cap did not count it (the token cap did). Use --max-tokens and run `wf metrics reconcile` later.",
      });
    }
    addUsage(totals, usage);
    return { charged, raw: u?.cost?.rawCostCents, costFinal: Boolean(u?.cost), usage, reasoningTokens: u?.usage.reasoningTokens ?? turnUsage.reasoningTokens, runs: u?.runs ?? [] };
  }

  /** What `runStep` needs to know about an `agent()` call, computed synchronously before any await. */
  interface StepContext {
    o: AgentCallOptions;
    role: string | undefined;
    promptHash: string;
    label: string;
    phase: string | undefined;
    sources: SettingSource[];
    /** Where the step runs: its role's location in the config, once the global `allowedLocations` cap has applied. */
    location: StepLocation;
    mKey: string | undefined;
    fingerprint: Record<string, unknown>;
    /** Journal key. */
    key: string;
    ref: StepRef;
    /** A step-start has been emitted: only then does the step become the flow's "last node". */
    started: boolean;
    /** The step's token cap (config `maxTokensPerStep`, already clamped): all its attempts together. `null` = none. */
    tokenCap: number | null;
    /** Tokens the step's finished attempts used, from their turn events. */
    tokens: number;
  }

  async function agentCall<T>(prompt: string, callOpts: AgentCallOptions = {}): Promise<T> {
    const flow = currentFlow();
    const promptHash = sha(prompt).slice(0, 16);
    // Label padrão é um hash, não o começo do prompt: nada de conteúdo de issue/código nas métricas e logs.
    const label = callOpts.label ?? `step-${promptHash.slice(0, 8)}`;
    const role = callOpts.role;
    if (role !== undefined && !roles.has(role)) {
      throw new StepFailedError(`step "${label}": unknown role "${role}" (the workflow declares: ${[...roles.keys()].join(", ") || "none"})`);
    }
    // Workflow defaults < the role's defaults < this call < the config layers: what the user configured wins over the code.
    const overrides = resolved.stepOverrides(role, label);
    const o = applyOverrides({ ...def.defaults, ...(role === undefined ? undefined : roles.get(role)!.defaults), ...callOpts }, overrides);
    const phase = o.phase ?? currentPhase;
    const sources = allowedSources(caps.allowedSettingSources, o.settingSources ?? settingSources);
    const mKey = modelKey(o.model);
    const fingerprint = {
      model: o.model,
      schema: o.schema,
      cwd: o.cwd,
      tools: o.tools,
      disallowedTools: o.disallowedTools,
      agents: o.agents,
      settingSources: sources,
    };
    // Chave calculada de forma síncrona, antes de qualquer await.
    const key = journal.keyFor(prompt, fingerprint);
    const ref: StepRef = { stepId: stepIdOf(key), parentId: flow.last, groupId: flow.groupId };
    const step: StepContext = { o, role, promptHash, label, phase, sources, location: overrides.location, mKey, fingerprint, key, ref, started: false, tokenCap: overrides.maxTokensPerStep, tokens: 0 };
    return inNode(runStep<T>(prompt, step), flow, ref, () => step.started);
  }

  /**
   * Awaits one node of the run (an agent step, a command) as a task in flight: a cancelled run waits for it to stop before
   * it ends, and a cancellation that reaches it marks the run interrupted. Whatever comes next in the flow continues from
   * the node, once `started()` says it has begun.
   */
  async function inNode<T>(running: Promise<T>, flow: Flow, ref: StepRef, started: () => boolean): Promise<T> {
    inFlight.add(running);
    try {
      return await running;
    } catch (err) {
      if (err instanceof RunCancelledError) interrupted = true;
      throw err;
    } finally {
      inFlight.delete(running);
      if (started()) flow.last = ref.stepId;
    }
  }

  async function runStep<T>(prompt: string, step: StepContext): Promise<T> {
    const { o, role, promptHash, label, phase, sources, location, mKey, fingerprint, key, ref } = step;
    const emitStart = (attemptId: string, attempt: number, cachedFrom: false | "journal" | "memo") => {
      step.started = true;
      emit({
        type: "step-start",
        ...ref,
        attemptId,
        stepKey: key,
        label,
        phase,
        cached: cachedFrom,
        role,
        location: cachedFrom ? undefined : location,
        model: o.model?.id,
        modelKey: mKey,
        modelParams: o.model?.params,
        attempt,
        tools: o.tools,
        settingSources: sources,
        promptHash,
        promptChars: prompt.length,
      });
    };
    /** A step served without calling the API still emits its step-start, so it exists in the log like any other. */
    const servedFrom = (from: "journal" | "memo") => {
      const attemptId = randomUUID();
      emitStart(attemptId, 1, from);
      emit({ type: "step-end", ...ref, attemptId, stepKey: key, label, phase, ok: true, cached: from, chargedCents: 0, model: o.model?.id, modelKey: mKey });
    };
    const stepCwd = o.cwd ?? opts.cwd;
    const cached = journal.get(key);
    if (cached) {
      servedFrom("journal");
      return cached.result as T;
    }
    let memoKey: string | undefined;
    if (o.memo) {
      if (!isReadOnly(o.tools)) {
        throw new StepFailedError(`step "${label}": memo requires \`tools\` with read-only tools only (read, grep, glob, ls, semSearch...)`);
      }
      if (location === "cloud") {
        // A cloud agent's answer depends on its VM and on the snapshot, not only on the repository state the memo key holds.
        emit({ type: "warning", message: `step "${label}": memo skipped (cloud steps are not memoized)` });
      } else {
        const state = await repoState(stepCwd);
        if (state) {
          memoKey = memo.key({ prompt, ...fingerprint, cwd: undefined }, state);
          const hit = memo.get(memoKey);
          if (hit !== undefined) {
            journal.record({ key, label, model: o.model?.id, result: hit, chargedCents: 0, totalTokens: 0 });
            servedFrom("memo");
            return hit as T;
          }
        } else {
          emit({ type: "warning", message: `step "${label}": memo skipped (cwd is not a git repository with a commit, or git did not answer in time)` });
        }
      }
    }
    if (!o.model) throw new StepFailedError(`step "${label}" has no model: set opts.model or defaults.model`);
    if (!isModelAllowed(caps.allowedModels, o.model.id)) {
      throw new StepFailedError(`step "${label}": model ${o.model.id} is not in the global allowedModels cap (${caps.allowedModels!.join(", ")})`);
    }
    // A step runs on the backend of its location: the role's `location` in the config, which the global cap already limited.
    const backend = backendFor(location);
    if (caps.allowedLocations && !caps.allowedLocations.includes(backend.location)) {
      throw new StepFailedError(`step "${label}": the global allowedLocations cap (${caps.allowedLocations.join(", ") || "empty"}) does not allow ${backend.location} steps`);
    }
    // A cloud step is rejected before it spends anything. The workflow's declaration (`read-only`) is checked against what the step
    // does, which only a step knows; and a step that writes has no cloud path yet.
    const writes = !isReadOnly(o.tools);
    if (location === "cloud" && writes) {
      const declared = roles.get(role!)?.cloud;
      throw new StepFailedError(
        declared === "read-only"
          ? `step "${label}": role "${role}" is declared cloud: read-only by workflow ${def.meta.name}, but this step can write (its tools are not read-only), so it cannot run in the cloud`
          : `step "${label}": a step that can write cannot run in the cloud yet (role "${role}" is configured for it): give the step read-only \`tools\`, or set the role's location to local`,
      );
    }
    if (o.schema && o.schema.type !== "object") {
      throw new StepFailedError(`step "${label}": schema must have type "object" at the root (it becomes a tool's inputSchema)`);
    }
    const model = o.model;
    // What the backend gets: the step's options, resolved (the config layers and the global caps already applied).
    const stepOptions: StepOptions = {
      apiKey: opts.apiKey,
      name: `${def.meta.name}:${label}`,
      model,
      tools: o.tools,
      disallowedTools: o.disallowedTools,
      agents: o.agents,
      // O guarda vem antes: um mcpServers da etapa com o mesmo nome continua podendo substituí-lo de propósito.
      // In the cloud there is no guard: it is a command of this machine, which a VM cannot run, and the VM could not reach
      // this machine's `workflows` server either.
      mcpServers: location === "cloud" ? o.mcpServers : withGuard(nestedGuard(sources), o.mcpServers),
      cwd: stepCwd,
      settingSources: sources,
      // The global cap wins over the workflow code: a pull request that edits a workflow cannot turn sandboxing off.
      sandbox: caps.requireSandbox === true || Boolean(o.sandbox),
      writes,
      schema: o.schema,
      schemaRetries: o.schemaRetries ?? 2,
    };

    /**
     * An attempt of a cloud step that an earlier execution left running has an agent now: the log closes the dead attempt, so the
     * next resume meets the new one instead. When the attempt took the same agent over, it pays for the agent's whole usage, so
     * the dead attempt closes uncharged and the budget stops counting the turns it had reported. When the cloud had lost the agent
     * and a new one started, those turns were real spend that nothing else will count: the dead attempt closes with them.
     */
    const closeInterrupted = (interrupted: InterruptedCloudStep, attempt: number, sameAgent: boolean): void => {
      const counted = interrupted.countedTokens;
      emit({
        type: "step-end",
        ...ref,
        attemptId: interrupted.attemptId,
        stepKey: key,
        label,
        phase,
        ok: false,
        cached: false,
        location,
        chargedCents: 0,
        model: o.model?.id,
        modelKey: mKey,
        usage: sameAgent || counted.totalTokens === 0 ? undefined : counted,
        errorKind: "exception",
        error: `the process that was executing this attempt ended before it did; attempt ${attempt} ${sameAgent ? "reattached to" : "replaced"} its cloud agent ${interrupted.agentId}`,
        agentId: interrupted.agentId,
      });
      if (!sameAgent) return;
      spentTokens -= counted.totalTokens;
      subtractUsage(totals, counted);
      emit({
        type: "warning",
        message: `step "${label}": reattached to cloud agent ${interrupted.agentId}, which an earlier execution of this run left running; what the agent did while no process was watching is not in the event log (only its final answer is, as one message), and the live token caps act only when its run ends`,
      });
    };

    await sem.acquire();
    try {
      // A step that can write is reverted if the run is cancelled in the middle of it, so a resume meets no half-made edits,
      // and, when the call asks (`revertOnRetry`), before each retry, so a retry meets none of the failed attempt's.
      const snapshot = writes && !signal?.aborted ? await takeSnapshot(stepCwd) : undefined;
      const reverter = reverts.forStep({ writes, snapshot, stepCwd, label, warn: (message) => emit({ type: "warning", message }) });
      const attempts = 1 + (o.retries ?? 1);
      let lastError = "";
      // A cloud step an earlier execution left running: the first attempt takes its agent over instead of creating another.
      let reattach = location === "cloud" ? store.interruptedCloud.get(ref.stepId) : undefined;
      let tookOver = false;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) {
          // Cancelled while queued or between attempts: this attempt never starts (no step-start). The attempts before it may have left edits.
          if (attempt > 1) await reverter.onCancel();
          assertNotCancelled();
        }
        assertBudget();
        // Same rule as the run's cap: nothing left of the step's allowance, no attempt starts (a cap of 0 lets no step run).
        if (step.tokenCap != null && step.tokens >= step.tokenCap) throw stepCapError(step, step.tokens);
        const attemptId = randomUUID();
        const startedAt = Date.now();
        const timeoutMs = o.timeoutMs ?? 20 * 60_000;
        emitStart(attemptId, attempt, false);
        const content = attemptContent(ref, attemptId);
        content.write("prompt", prompt);
        // Contadores alimentados pelo stream de eventos do backend.
        const c: AttemptCounters = { turns: 0, steps: 0, stepsInTurn: 0, summaries: 0, reprompts: 0, toolCalls: {} };
        // Soma dos turnos desta tentativa: reserva de tokens quando o backend não consegue ler o uso.
        const turnUsage: UsageTotals & { reasoningTokens?: number } = emptyUsage();
        // The attempt's abort switch: the run's cancellation, the step's timeout (creation, send, wait and schema re-prompts
        // share it) and the live token caps all end the attempt through its signal.
        const abort = new AttemptAbort();
        const onRunAbort = () => abort.abort(new RunCancelledError(cancelMessage));
        signal?.addEventListener("abort", onRunAbort, { once: true });
        const timer = setTimeout(() => abort.abort(new StepTimeoutError(`timeout after ${timeoutMs} ms`)), timeoutMs);
        // Live caps: a turn that takes the step or the run over its token cap cuts the attempt (its own turn, or another
        // step's turn for the run's cap).
        live.add(turnUsage);
        cutters.add(abort);
        const handle = attemptEvents(c, content, {
          turn: (t) => {
            emit({ type: "turn", ...ref, attemptId, idx: c.turns, steps: c.stepsInTurn, usage: t });
            addUsage(turnUsage, turnTokens(t));
            if (t.reasoningTokens) turnUsage.reasoningTokens = (turnUsage.reasoningTokens ?? 0) + t.reasoningTokens;
            // The real SDK may report one turn per send, so this can fire only when a send ends (see #37).
            const breach = tokenBreach(step, turnUsage.totalTokens);
            if (breach instanceof BudgetExceededError) for (const active of cutters) active.cut(breach); // the run's cap: every active attempt
            else if (breach) abort.cut(breach);
          },
          warning: (message) => emit({ type: "warning", message: `step "${label}": ${message}` }),
          // A cloud agent is written to the log the moment it exists: a crash from here on leaves its id behind for the resume.
          agent: (agent) => {
            if (location !== "cloud") return;
            if (reattach && !tookOver) {
              tookOver = true; // the dead attempt is closed once, whatever the next attempts do
              closeInterrupted(reattach, attempt, agent.agentId === reattach.agentId);
            }
            emit({ type: "cloud-agent", ...ref, attemptId, agentId: agent.agentId, reattached: agent.reattached, snapshot: agent.snapshot });
          },
        });
        const onEvent = (event: AttemptEvent) => {
          if (event.type !== "warning") abort.agentReady(); // any other event means the agent exists: a cap held back while it was being created applies now
          handle(event);
        };
        let charge: Charge | undefined;
        let errorKind: ErrorKind | undefined;
        let cancelledBy: RunCancelledError | undefined;
        let reverted = false;
        let agentId: string | undefined;
        let resolvedModel: string | undefined;
        const endEvent = (ok: boolean) => {
          content.flush();
          emit({
            type: "step-end",
            ...ref,
            attemptId,
            stepKey: key,
            label,
            phase,
            attempt,
            ok,
            cached: false,
            location,
            chargedCents: charge?.charged ?? 0,
            rawCents: charge?.raw,
            costFinal: charge?.costFinal ?? false,
            model: model.id,
            resolvedModel,
            modelKey: mKey,
            usage: charge?.usage,
            reasoningTokens: charge?.reasoningTokens,
            errorKind: ok ? undefined : errorKind,
            reverted: reverted || undefined,
            error: ok ? undefined : lastError,
            schemaReprompts: c.reprompts,
            turns: c.turns,
            steps: c.steps,
            toolCalls: c.toolCalls,
            summaries: c.summaries,
            agentId,
            usageRuns: charge?.runs,
            durationMs: Date.now() - startedAt,
          });
        };
        try {
          let result: AttemptResult;
          try {
            result = await backend.run(prompt, reattach ? { ...stepOptions, reattach: { agentId: reattach.agentId, snapshot: reattach.snapshot } } : stepOptions, abort.signal, onEvent);
          } catch (err) {
            // A backend reports its failures in the result; one that throws has a bug. The attempt fails, uncharged.
            result = { outcome: { kind: "error", reason: "other", message: err instanceof Error ? err.message : String(err) } };
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onRunAbort);
            cutters.delete(abort);
          }
          agentId = result.agentId;
          resolvedModel = result.model;
          // Timeout/error also cost. No reading and no turns: no agent existed, so nothing was used.
          if (result.usage || turnUsage.totalTokens > 0) charge = chargeUsage(result.usage ?? { failed: "the backend reported no usage" }, turnUsage);
          const { outcome } = result;
          // An attempt that could not reach the interrupted agent leaves it to the next attempt; any other ending is done with it.
          if (!result.reattachFailed) reattach = undefined;
          switch (outcome.kind) {
            case "finished":
              journal.record({ key, label, model: model.id, result: outcome.value, chargedCents: charge?.charged ?? 0, totalTokens: charge?.usage.totalTokens ?? 0 });
              if (memoKey) memo.set(memoKey, outcome.value);
              endEvent(true);
              return outcome.value as T;
            case "run-error":
              errorKind = "run-error";
              lastError = outcome.message;
              break;
            case "schema":
              errorKind = "schema";
              lastError = outcome.message;
              break;
            case "aborted": {
              lastError = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
              if (abort.isCutBy(outcome.reason)) {
                // Over a token cap: the attempt fails as "budget" and is not retried. The run's cap ends the run, the step's cap only the step.
                errorKind = "budget";
                endEvent(false);
                throw outcome.reason;
              }
              if (outcome.reason instanceof RunCancelledError) {
                errorKind = "cancelled";
                cancelledBy = outcome.reason;
              } else {
                errorKind = outcome.reason instanceof StepTimeoutError ? "timeout" : "exception";
              }
              break;
            }
            case "error":
              lastError = outcome.message;
              if (outcome.reason === "account") {
                errorKind = "exception";
                endEvent(false);
                accountError ??= new AccountAccessError(`The account's plan does not give access to the Cursor SDK (${outcome.code}): ${lastError}`);
                throw accountError;
              }
              if (outcome.reason === "usage-limit") {
                // Not retryable = the plan's usage cap ("Usage limit exceeded" in the SDK doc): trying again does not help.
                errorKind = "rate-limit";
                endEvent(false);
                throw new BudgetExceededError(`Cursor usage limit reached: ${lastError}`);
              }
              if (outcome.reason === "rate-limit") {
                errorKind = "rate-limit";
                await sleep(2000 * 2 ** (attempt - 1));
              } else {
                errorKind = /^timeout/.test(lastError) ? "timeout" : "exception"; // a timeout the backend itself reports in its message
              }
              break;
          }
        } finally {
          live.delete(turnUsage); // idempotent: an attempt that never got to be charged must not keep counting
          step.tokens += turnUsage.totalTokens;
        }
        if (cancelledBy) reverted = await reverter.onCancel();
        else if (o.revertOnRetry && attempt < attempts) reverted = await reverter.beforeRetry();
        endEvent(false);
        if (cancelledBy) throw cancelledBy;
      }
      throw new StepFailedError(`step "${label}" failed after ${attempts} attempt(s): ${lastError}`);
    } finally {
      sem.release();
    }
  }

  /** How many times each call has been made in this execution, by its shape and the branch that made it: the same call twice is two nodes, and a resume numbers them alike. */
  const execOccurrences = new Map<string, number>();

  /** One `ctx.exec` call: a step node of the run. The command runs in its own process, and the call returns what the command did. */
  async function execCall(command: string, args: string[] = [], callOpts: ExecOptions = {}): Promise<ExecResult> {
    const flow = currentFlow();
    const cwd = callOpts.cwd ?? opts.cwd;
    const timeoutMs = callOpts.timeoutMs ?? resolved.config.execTimeoutMs;
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new StepFailedError(`ctx.exec: timeoutMs must be a positive number of milliseconds, got ${timeoutMs}`);
    if (signal?.aborted) {
      interrupted = true; // a cancelled run starts no command: no node either
      throw new RunCancelledError(cancelMessage);
    }
    // The node's id comes from the call's shape and its branch (`flow.prefix`: where it sits in the groups), computed before
    // any await: the numbering does not depend on which parallel branch gets there first.
    const shape = sha(JSON.stringify([flow.prefix, command, args, cwd]));
    const occurrence = execOccurrences.get(shape) ?? 0;
    execOccurrences.set(shape, occurrence + 1);
    const ref: StepRef = { stepId: `x-${shape.slice(0, 12)}.${occurrence}`, parentId: flow.last, groupId: flow.groupId };
    return inNode(runExec(command, args, cwd, timeoutMs, callOpts, ref), flow, ref, () => true); // runExec opens the node at once
  }

  async function runExec(command: string, args: string[], cwd: string, timeoutMs: number, callOpts: ExecOptions, ref: StepRef): Promise<ExecResult> {
    const attemptId = randomUUID();
    const label = callOpts.label ?? command;
    const phase = callOpts.phase ?? currentPhase;
    const startedAt = Date.now();
    emit({ type: "exec-start", ...ref, attemptId, label, phase, command, timeoutMs });
    // The command line and the output are content: same redaction, same cut and same retention as an agent's.
    const content = attemptContent(ref, attemptId);
    content.write("tool-call", JSON.stringify({ command, args, cwd }), { tool: "exec", callId: attemptId });
    const log = outputLog((stream, text) => content.write("command-output", text, { tool: "exec", callId: attemptId, stream }), { pieceMax: CONTENT_MAX_CHARS, logMax: EXEC_LOG_MAX_CHARS });
    const flushing = setInterval(() => log.flush(), EXEC_FLUSH_MS);
    let done: CommandOutcome;
    try {
      done = await runCommand({ command, args, cwd, env: callOpts.env, timeoutMs, signal }, log.push);
    } finally {
      clearInterval(flushing);
      log.end();
    }
    const result = toExecResult(done);
    emit({
      type: "exec-end",
      ...ref,
      attemptId,
      label,
      phase,
      command,
      ok: result.ok,
      outcome: done.outcome,
      exitCode: done.exitCode ?? undefined,
      signal: done.signal ?? undefined,
      error: done.error,
      durationMs: Date.now() - startedAt,
      outputChars: done.outputChars,
      outputTruncated: log.truncated || undefined,
    });
    if (done.outcome === "cancelled") throw new RunCancelledError(cancelMessage); // the command is dead: the workflow must not go on
    return result;
  }

  const ctx: WorkflowContext<A> = {
    args,
    runId,
    cwd: opts.cwd,
    budget,
    settings: structuredClone(resolved.config.settings),
    agent: agentCall,
    exec: execCall,
    parallel: (thunks) =>
      runGroup("parallel", thunks, (thunk) =>
        thunk().catch((err: unknown) => {
          if (err instanceof FatalRunError) throw err; // teto de custo ou conta sem acesso aborta o workflow inteiro
          emit({ type: "warning", message: `parallel: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        }),
      ),
    pipeline: (items, ...stages) =>
      runGroup("pipeline", items, async (item, index) => {
        let prev: unknown = item;
        try {
          for (const stage of stages) prev = await stage(prev, item, index);
          return prev;
        } catch (err) {
          if (err instanceof FatalRunError) throw err;
          emit({ type: "warning", message: `pipeline item ${index}: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        }
      }),
    phase(title) {
      currentPhase = title;
      emit({ type: "phase", title });
    },
    log(message) {
      emit({ type: "log", message });
    },
    card({ title, subtitle, links, badges }) {
      // Field by field, copied: an object with more than the card's fields, or one the workflow edits afterwards, changes nothing in the log.
      emit({ type: "card", title, subtitle, links: links?.map(({ label, url }) => ({ label, url })), badges: badges && [...badges] });
    },
    metric(name, value) {
      emit({ type: "metric", name, value });
    },
  };

  let ended: { status: RunStatus; result?: R; error?: string };
  try {
    const workflow = flows.run(rootFlow, () => def.run(ctx));
    ended = { status: "finished", result: await (abandoned ? Promise.race([workflow, abandoned]) : workflow) };
  } catch (err) {
    if (err instanceof RunCancelledError) interrupted = true;
    ended = { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  // A run that hit its token cap cancelled its active steps; they finish their accounting before the run is closed, so no
  // step event trails the run-end and their tokens are in the outcome.
  if (runBreach) {
    await settledWithin([...inFlight], CANCEL_GRACE_MS);
    // The workflow may have caught the step's error and carried on: crossing the run's cap still ends the run with the budget error.
    if (ended.status === "finished") ended = { status: "failed", error: runBreach.message };
  }
  if (interrupted) {
    // The other branches of a parallel may still be stopping (and reverting): the run ends after the last of them.
    await Promise.allSettled([...inFlight]);
    ended = { status: "cancelled", error: cancelMessage };
  }
  const final = outcome(ended.status, ended.status === "finished" ? { result: ended.result } : { error: ended.error });
  const r = final.result as { status?: unknown } | undefined;
  emit({
    type: "run-end",
    status: final.status,
    outcomeStatus: r && typeof r === "object" && typeof r.status === "string" ? r.status : undefined,
    result: final.result,
    error: final.error,
  });
  closeEvents();
  return final;
}
