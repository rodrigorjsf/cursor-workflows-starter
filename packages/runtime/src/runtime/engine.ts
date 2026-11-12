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
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentBusyError,
  RateLimitError,
  type ModelSelection,
  type Run,
  type RunResult,
  type RunUsage,
  type SDKAgent,
  type SendOptions,
  type SettingSource,
} from "@cursor/sdk";
import { Ajv } from "ajv";
import { type AgentBackend, localBackend } from "./backend.js";
import { ConfigError, STEP_OVERRIDE_FIELDS, type LimitOverrides, type ResolvedConfig, type StepOverrides, allowedSources, isModelAllowed, loadEffectiveConfig } from "../config/index.js";
import { type ContentKind, EVENT_SCHEMA_VERSION, type ErrorKind, type NewEvent, type RunStatus, type StepRef, type TurnUsage, type WorkflowEvent } from "./events.js";
import { MemoStore, isReadOnly, repoState } from "./memo.js";
import { addUsage, emptyUsage, resumeHint, withRatio } from "./projection.js";
import { RunLockedError, RunStore } from "./run-store.js";
import type { RetentionPolicy } from "./retention.js";
import { registerRun } from "./runs-index.js";
import { stateDir as runtimeStateDir } from "./state.js";
import { type Capture, SUBMIT_TOOL, repromptMessage, schemaInstruction, submitResultTool } from "./structured.js";
import type { AgentCallOptions, Budget, UsageTotals, WorkflowContext, WorkflowDefinition } from "./workflow.js";
import { workflowSourceHash } from "./workflow-source.js";
import { type Snapshot, revertToSnapshot, takeSnapshot } from "./worktree-snapshot.js";

export type { ErrorKind, RunStatus, TurnUsage, WorkflowEvent } from "./events.js";

/** Erro que encerra o run inteiro, inclusive dentro de parallel/pipeline (não vira null). */
export class FatalRunError extends Error {}
export class BudgetExceededError extends FatalRunError {}
/** A conta não tem acesso ao SDK (ex.: plano Free: `plan_required` já no Agent.create). Tentar de novo não adianta. */
export class AccountAccessError extends FatalRunError {}
/** Códigos de erro do SDK que dizem respeito à conta, não à etapa. */
const ACCOUNT_ERROR_CODES = new Set(["plan_required"]);
export class StepFailedError extends Error {}
/** A step crossed its own token cap (`maxTokensPerStep`): the step fails with no retry, the run goes on. */
export class StepBudgetError extends StepFailedError {}
/** How long a run that hit its token cap waits for the steps it cancelled to finish their accounting before it ends. */
const CANCEL_GRACE_MS = 30_000;

/**
 * The "stop this attempt now" switch of one attempt, thrown when a token cap is crossed. `cut(err)` cancels the SDK run
 * in flight and makes `rejected` reject, so the wait on the run fails at once; `throwIfCut()` is for the points where
 * the attempt can notice on its own. A turn can arrive before `send()` hands the run back: the run is then cancelled as
 * soon as it is bound.
 */
class AttemptCut {
  private run: Run | undefined;
  private reason: Error | undefined;
  private cancelling: Promise<void> | undefined;
  private reject!: (err: Error) => void;
  /** Rejects with the error that cut the attempt. */
  readonly rejected = new Promise<never>((_, reject) => (this.reject = reject));

  constructor() {
    this.rejected.catch(() => {}); // only the race in waitWithTimeout observes it
  }

  /** The SDK run in flight, or undefined between runs (finished runs have nothing left to cancel). */
  bind(run: Run | undefined): void {
    this.run = run;
  }

  cut(err: Error): void {
    if (this.reason) return;
    this.reason = err;
    this.reject(err);
    this.cancelRun();
  }

  throwIfCut(): void {
    if (!this.reason) return;
    this.cancelRun();
    throw this.reason;
  }

  isCutBy(err: unknown): boolean {
    return this.reason !== undefined && err === this.reason;
  }

  /** Resolves once the run cancelled by the cut has stopped. */
  stopped(): Promise<void> {
    return this.cancelling ?? Promise.resolve();
  }

  private cancelRun(): void {
    if (this.run) this.cancelling ??= this.run.cancel().catch(() => {});
  }
}
/** The step's time ran out (the attempt's creation, send and wait share it). */
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
    repo: repoIdentity(opts.cwd),
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
      message: `o código do workflow mudou desde a execução anterior deste run (${store.previousStart.workflowHash} → ${workflowHash}): o run retomado mistura versões`,
    });
  }
  if (!store.previousStart) {
    // First execution of this run: register it where tools outside the repo can find it. A resume is the same run.
    try {
      registerRun({ runId, repo: resolve(opts.cwd), workflow: def.meta.name, startedAt });
    } catch (err) {
      emit({ type: "warning", message: `não foi possível registrar o run no índice global: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  for (const { runId: prunedRun, error } of pruned.failed) {
    emit({ type: "warning", message: `não foi possível apagar o conteúdo antigo do run ${prunedRun}: ${error}` });
  }
  if (store.tornTail.events) emit({ type: "warning", message: "a última linha do log de eventos estava incompleta (queda no meio de uma gravação): ignorada" });
  if (store.tornTail.journal) emit({ type: "warning", message: "a última linha do journal estava incompleta (queda no meio de uma gravação): a etapa dela roda de novo" });
}

/** Reverts run one at a time: two steps writing in the same directory must not restore it at once. */
class RevertQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Returns what puts a step's directory back as it was before the step (once). It never throws; true when it did. */
  forStep(o: { writes: boolean; snapshot: Snapshot | undefined; stepCwd: string; label: string; warn: (message: string) => void }): () => Promise<boolean> {
    let reverting: Promise<boolean> | undefined;
    return () => {
      if (!o.writes) return Promise.resolve(false);
      if (reverting) return reverting;
      const run = this.tail.then(async () => {
        if (!o.snapshot) {
          o.warn(`etapa "${o.label}" cancelada: ${o.stepCwd} não é um repositório git (ou o git falhou), então as alterações da etapa não foram desfeitas`);
          return false;
        }
        try {
          await revertToSnapshot(o.snapshot);
          return true;
        } catch (err) {
          o.warn(`etapa "${o.label}" cancelada: não foi possível desfazer as alterações em ${o.stepCwd}: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      });
      this.tail = run;
      return (reverting = run);
    };
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
  write(kind: ContentKind, raw: string, extra?: { tool?: string; callId?: string }): void;
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
      recorderWarning = `métricas desligadas: ${err instanceof Error ? err.message : String(err)}`;
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
      opts.onEvent?.(stamp({ type: "warning", message: `falha ao gravar o log de eventos: ${err instanceof Error ? err.message : String(err)}` }));
    }
  };
  const emit = (e: NewEvent) => {
    const event = stamp(e);
    append(event);
    try {
      recorder?.record(event);
    } catch (err) {
      const warning = stamp({ type: "warning", message: `falha ao gravar métrica: ${err instanceof Error ? err.message : String(err)}` });
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
    const write = (kind: ContentKind, raw: string, extra: { tool?: string; callId?: string } = {}) => {
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

/** send() com tolerância a AgentBusyError (a run anterior ainda fechando). */
async function sendWhenFree(agent: SDKAgent, message: string, options?: SendOptions): Promise<Run> {
  for (let i = 0; ; i++) {
    try {
      return await agent.send(message, options);
    } catch (err) {
      if (err instanceof AgentBusyError && i < 5) {
        await sleep(1000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

/** What an attempt counts from the SDK's stream of deltas. */
interface AttemptCounters {
  turns: number;
  steps: number;
  stepsInTurn: number;
  summaries: number;
  reprompts: number;
  toolCalls: Record<string, number>;
}

/**
 * The `onDelta` of one attempt: counts turns, steps, summaries and tool calls, writes the attempt's content, and hands
 * each ended turn's usage to `onTurn` (which emits the turn event and enforces the live caps).
 */
function attemptDeltas(c: AttemptCounters, content: AttemptContent, onTurn: (usage: TurnUsage) => void): NonNullable<SendOptions["onDelta"]> {
  return ({ update }) => {
    switch (update.type) {
      case "step-completed":
        c.steps++;
        c.stepsInTurn++;
        break;
      case "text-delta":
        content.say(update.text);
        break;
      case "tool-call-started": {
        const name = update.toolCall?.type ?? "unknown";
        c.toolCalls[name] = (c.toolCalls[name] ?? 0) + 1;
        content.write("tool-call", JSON.stringify((update.toolCall as { args?: unknown }).args ?? null), { tool: name, callId: update.callId });
        break;
      }
      case "tool-call-completed": {
        const output = update.toolCall?.type === "shell" ? shellOutput(update.toolCall.result) : undefined;
        if (output !== undefined) content.write("command-output", output, { tool: "shell", callId: update.callId });
        break;
      }
      case "summary-completed":
        c.summaries++;
        break;
      case "turn-ended":
        content.flush();
        if (update.usage) onTurn(update.usage);
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

/** The output of a finished shell tool call, as one text: exit code, stdout, then stderr. Undefined when the call has no result. */
function shellOutput(result: unknown): string | undefined {
  const r = result as { status?: string; value?: { exitCode?: number; stdout?: string; stderr?: string }; error?: unknown } | undefined;
  if (r?.status === "success" && r.value) {
    const { exitCode, stdout = "", stderr = "" } = r.value;
    return `exit ${exitCode}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
  }
  if (r?.status === "error") return `error: ${JSON.stringify(r.error)}`;
  return undefined;
}

function repoIdentity(cwd: string): { name: string; hash: string } {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let top = cwd;
  let origin = "";
  try {
    top = git("rev-parse", "--show-toplevel");
    origin = git("remote", "get-url", "origin");
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
    if (!validate(args)) return refused(`args inválidos: ${ajv.errorsText(validate.errors)}`);
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
  announceRun({ def, args, opts, runId, store, resolved, emit, recorderWarning });

  process.env[INSIDE_WORKFLOW_ENV] = "1";
  const journal = store.journal;
  const memo = new MemoStore(opts.cwd);
  const sem = new Semaphore(limits.concurrency);
  const settingSources = opts.settingSources ?? ["project", "team", "mdm"];
  const roles = new Map((def.meta.roles ?? []).map((r) => [r.name, r]));
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
  const cutters = new Set<AttemptCut>();
  let runBreach: BudgetExceededError | undefined;

  const stepCapError = (step: StepContext, tokens: number) => new StepBudgetError(`Teto de tokens da etapa "${step.label}" atingido: ${tokens} de ${step.tokenCap}.`);

  /** Has the turn that just ended taken the run or the step over a token cap? The run's cap wins: it ends the run. */
  function tokenBreach(step: StepContext, attemptTokens: number): Error | undefined {
    if (runBreach) return runBreach;
    if (budget.maxTokens != null) {
      let total = spentTokens;
      for (const usage of live) total += usage.totalTokens;
      if (total > budget.maxTokens) return (runBreach = new BudgetExceededError(`Teto de tokens atingido: ${total} de ${budget.maxTokens}.`));
    }
    const stepTokens = step.tokens + attemptTokens;
    return step.tokenCap != null && stepTokens > step.tokenCap ? stepCapError(step, stepTokens) : undefined;
  }

  // Cancellation. `cancelled` rejects when the signal aborts; it is only ever raced against something, never awaited alone.
  const signal = opts.signal;
  const cancelMessage = `run cancelado; ${resumeHint(runId)}`;
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
      throw new BudgetExceededError(`Teto de custo atingido: ${spentCents}¢ de ${budget.maxCents}¢.`);
    }
    if (budget.maxTokens != null && spentTokens >= budget.maxTokens) {
      throw new BudgetExceededError(`Teto de tokens atingido: ${spentTokens} de ${budget.maxTokens}.`);
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
   * Lê custo e tokens do agente. O custo "pode atrasar um pouco depois do fim da run": tenta de novo se vier vazio.
   * `turnUsage` é a soma dos eventos `turn-ended` da tentativa: vira a fonte dos tokens quando `getUsage()` falha
   * (a doc do SDK diz que, para agentes locais, ele pode responder 403 `feature_unavailable` conforme a conta).
   */
  async function chargeUsage(agent: SDKAgent, turnUsage: UsageTotals & { reasoningTokens?: number }): Promise<Charge> {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      const u = await agent.getUsage().catch((err: unknown) => {
        lastErr = err;
        return undefined;
      });
      const unavailable = (lastErr as { code?: unknown } | undefined)?.code === "feature_unavailable";
      if (u?.cost || i === 2 || unavailable) {
        const charged = u?.cost?.chargedCents ?? 0;
        const usage = emptyUsage();
        addUsage(usage, u ? u.usage : turnUsage);
        // O cobrado pode ficar acima do bruto (Cursor Token Fee); o bruto, acima do cobrado (uso incluído no plano).
        spentCents += Math.max(u?.cost?.rawCostCents ?? 0, charged);
        chargedCents += charged;
        spentTokens += usage.totalTokens;
        live.delete(turnUsage); // its tokens are in spentTokens now (here, not in the attempt's finally: a rate-limit backoff sleeps in between)
        if (!u) {
          const why = lastErr instanceof Error ? lastErr.message : String(lastErr);
          emit({
            type: "warning",
            message: `getUsage() falhou (${why.slice(0, 160)}): tokens contados pelos eventos turn-ended; custo desconhecido, o teto em centavos não contou esta tentativa. Use --max-tokens.`,
          });
        } else if (!u.cost) {
          emit({
            type: "warning",
            message: "custo da tentativa ainda não reportado pelo Cursor: o teto em centavos não a contou (o de tokens, sim). Use --max-tokens e rode `wf metrics reconcile` depois.",
          });
        }
        addUsage(totals, usage);
        return { charged, raw: u?.cost?.rawCostCents, costFinal: Boolean(u?.cost), usage, reasoningTokens: u?.usage.reasoningTokens ?? turnUsage.reasoningTokens, runs: u?.runs ?? [] };
      }
      await sleep(1000);
    }
    return { charged: 0, costFinal: false, usage: emptyUsage(), runs: [] };
  }

  /** When an attempt's time runs out: `at` is the instant, `ms` the step's timeout, which the error message reports. */
  interface Deadline {
    at: number;
    ms: number;
  }

  /**
   * Races `promise` against the attempt's deadline and the run's cancellation: throws a `StepTimeoutError` when the time
   * runs out and a `RunCancelledError` when the run is cancelled. A value that arrives after the race was given up goes to
   * `late`, so an agent created too late is still disposed. `abort` rejects when the attempt is cut (token cap): it wins
   * over a result that arrives at the same time.
   */
  async function within<T>(attempt: Deadline, promise: Promise<T>, late?: (value: T) => void, abort?: Promise<never>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(`timeout após ${attempt.ms} ms`)), Math.max(0, attempt.at - Date.now()));
    });
    try {
      return await Promise.race([...(abort ? [abort] : []), promise, timeout, ...(cancelled ? [cancelled] : [])]);
    } catch (err) {
      promise.then(late, () => {}); // given up (or failed): whatever it yields later is not ours
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitWithTimeout(run: Run, attempt: Deadline, abort?: Promise<never>): Promise<RunResult> {
    try {
      return await within(attempt, run.wait(), undefined, abort);
    } catch (err) {
      // Waits for the cancellation to finish so the next attempt does not edit the same cwd in parallel.
      if (err instanceof StepTimeoutError || err instanceof RunCancelledError) await run.cancel().catch(() => {});
      throw err;
    }
  }

  /** What `runStep` needs to know about an `agent()` call, computed synchronously before any await. */
  interface StepContext {
    o: AgentCallOptions;
    role: string | undefined;
    promptHash: string;
    label: string;
    phase: string | undefined;
    sources: SettingSource[];
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
    const label = callOpts.label ?? `etapa-${promptHash.slice(0, 8)}`;
    const role = callOpts.role;
    if (role !== undefined && !roles.has(role)) {
      throw new StepFailedError(`etapa "${label}": papel desconhecido "${role}" (o workflow declara: ${[...roles.keys()].join(", ") || "nenhum"})`);
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
    const step: StepContext = { o, role, promptHash, label, phase, sources, mKey, fingerprint, key, ref, started: false, tokenCap: overrides.maxTokensPerStep, tokens: 0 };
    const running = runStep<T>(prompt, step);
    inFlight.add(running);
    try {
      return await running;
    } catch (err) {
      if (err instanceof RunCancelledError) interrupted = true;
      throw err;
    } finally {
      inFlight.delete(running);
      if (step.started) flow.last = ref.stepId; // whatever comes next in this flow continues from this step
    }
  }

  async function runStep<T>(prompt: string, step: StepContext): Promise<T> {
    const { o, role, promptHash, label, phase, sources, mKey, fingerprint, key, ref } = step;
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
    const cached = journal.get(key);
    if (cached) {
      servedFrom("journal");
      return cached.result as T;
    }
    let memoKey: string | undefined;
    if (o.memo) {
      if (!isReadOnly(o.tools)) {
        throw new StepFailedError(`etapa "${label}": memo exige \`tools\` só com tools de leitura (read, grep, glob, ls, semSearch...)`);
      }
      const state = repoState(o.cwd ?? opts.cwd);
      if (state) {
        memoKey = memo.key({ prompt, ...fingerprint, cwd: undefined }, state);
        const hit = memo.get(memoKey);
        if (hit !== undefined) {
          journal.record({ key, label, model: o.model?.id, result: hit, chargedCents: 0, totalTokens: 0 });
          servedFrom("memo");
          return hit as T;
        }
      } else {
        emit({ type: "warning", message: `etapa "${label}": memo ignorado (cwd não é um repositório git com commit)` });
      }
    }
    if (!o.model) throw new StepFailedError(`etapa "${label}" sem modelo: defina opts.model ou defaults.model`);
    if (!isModelAllowed(caps.allowedModels, o.model.id)) {
      throw new StepFailedError(`etapa "${label}": o modelo ${o.model.id} não está no teto global allowedModels (${caps.allowedModels!.join(", ")})`);
    }
    // Every step runs on the local backend today; the cloud spec picks the backend per role (ADR-0005).
    const backend: AgentBackend = localBackend;
    if (caps.allowedLocations && !caps.allowedLocations.includes(backend.location)) {
      throw new StepFailedError(`etapa "${label}": o teto global allowedLocations (${caps.allowedLocations.join(", ") || "vazio"}) não permite etapas ${backend.location === "local" ? "locais" : "na nuvem"}`);
    }
    if (o.schema && o.schema.type !== "object") {
      throw new StepFailedError(`etapa "${label}": schema precisa ter type "object" na raiz (vira o inputSchema de uma tool)`);
    }
    const model = o.model;

    await sem.acquire();
    try {
      // A step that can write is reverted if the run is cancelled in the middle of it, so a resume meets no half-made edits.
      const stepCwd = o.cwd ?? opts.cwd;
      const writes = !isReadOnly(o.tools);
      const snapshot = writes && !signal?.aborted ? await takeSnapshot(stepCwd) : undefined;
      const revert = reverts.forStep({ writes, snapshot, stepCwd, label, warn: (message) => emit({ type: "warning", message }) });
      const attempts = 1 + (o.retries ?? 1);
      let lastError = "";
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) {
          // Cancelled while queued or between attempts: this attempt never starts (no step-start). The attempts before it may have left edits.
          if (attempt > 1) await revert();
          assertNotCancelled();
        }
        assertBudget();
        // Same rule as the run's cap: nothing left of the step's allowance, no attempt starts (a cap of 0 lets no step run).
        if (step.tokenCap != null && step.tokens >= step.tokenCap) throw stepCapError(step, step.tokens);
        const attemptId = randomUUID();
        const startedAt = Date.now();
        const timeoutMs = o.timeoutMs ?? 20 * 60_000;
        const deadline: Deadline = { at: startedAt + timeoutMs, ms: timeoutMs }; // creation, send, wait and schema re-prompts share it
        emitStart(attemptId, attempt, false);
        const content = attemptContent(ref, attemptId);
        content.write("prompt", prompt);
        // Contadores alimentados pelo stream de deltas do SDK.
        const c: AttemptCounters = { turns: 0, steps: 0, stepsInTurn: 0, summaries: 0, reprompts: 0, toolCalls: {} };
        // Soma dos turn-ended desta tentativa: reserva de tokens quando getUsage() não responde.
        const turnUsage: UsageTotals & { reasoningTokens?: number } = emptyUsage();
        // Live caps: a turn that takes the step or the run over its token cap cuts the attempt (its own turn, or another
        // step's turn for the run's cap).
        const attemptCut = new AttemptCut();
        live.add(turnUsage);
        cutters.add(attemptCut);
        const sendOpts: SendOptions = {
          onDelta: attemptDeltas(c, content, (t) => {
            emit({ type: "turn", ...ref, attemptId, idx: c.turns, steps: c.stepsInTurn, usage: t });
            addUsage(turnUsage, { ...t, totalTokens: t.inputTokens + t.outputTokens }); // o cache já está no input
            if (t.reasoningTokens) turnUsage.reasoningTokens = (turnUsage.reasoningTokens ?? 0) + t.reasoningTokens;
            // The real SDK may report one turn per send, so this can fire only when a send ends (see #37).
            const breach = tokenBreach(step, turnUsage.totalTokens);
            if (breach instanceof BudgetExceededError) for (const active of cutters) active.cut(breach); // the run's cap: every active attempt
            else if (breach) attemptCut.cut(breach);
          }),
        };
        const capture: Capture = { value: undefined, submitted: false };
        let agent: SDKAgent | undefined;
        let charge: Charge | undefined;
        let errorKind: ErrorKind | undefined;
        let cancelledBy: RunCancelledError | undefined;
        let reverted = false;
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
            agentId: agent?.agentId,
            usageRuns: charge?.runs,
            durationMs: Date.now() - startedAt,
          });
        };
        try {
          const sdkAgent = await within(deadline, backend.create({
            apiKey: opts.apiKey,
            name: `${def.meta.name}:${label}`,
            model,
            // Custom tools chegam ao modelo como o MCP server `custom-user-tools`: uma allowlist
            // sem "mcp" esconderia o submit_result.
            tools: o.schema && o.tools && !o.tools.includes("mcp") ? [...o.tools, "mcp"] : o.tools,
            disallowedTools: o.disallowedTools,
            agents: o.agents,
            // O guarda vem antes: um mcpServers da etapa com o mesmo nome continua podendo substituí-lo de propósito.
            mcpServers: withGuard(nestedGuard(sources), o.mcpServers),
            cwd: stepCwd,
            settingSources: sources,
            // The global cap wins over the workflow code: a pull request that edits a workflow cannot turn sandboxing off.
            sandbox: caps.requireSandbox === true || Boolean(o.sandbox),
            customTools: o.schema ? { [SUBMIT_TOOL]: submitResultTool(o.schema, capture) } : undefined,
          }), (late) => void late[Symbol.asyncDispose]().catch(() => {}));
          agent = sdkAgent;
          attemptCut.throwIfCut();
          /** One message and its answer. A cut attempt throws its budget error as soon as it knows, before anything else. */
          const exchange = async (message: string): Promise<RunResult> => {
            const run = await within(deadline, sendWhenFree(sdkAgent, message, sendOpts), (late) => void late.cancel().catch(() => {}));
            attemptCut.bind(run);
            attemptCut.throwIfCut();
            try {
              const answer = await waitWithTimeout(run, deadline, attemptCut.rejected);
              attemptCut.throwIfCut();
              return answer;
            } finally {
              attemptCut.bind(undefined); // finished or abandoned: a later cut has nothing to cancel until the next send()
            }
          };
          let result = await exchange(o.schema ? prompt + schemaInstruction() : prompt);
          resolvedModel = result.model?.id;
          // Saída estruturada: re-prompt na MESMA conversa até o modelo chamar submit_result com JSON válido.
          let schemaTries = o.schemaRetries ?? 2;
          while (o.schema && result.status === "finished" && !capture.submitted && schemaTries-- > 0) {
            c.reprompts++;
            const reprompt = repromptMessage(capture);
            content.write("prompt", reprompt);
            result = await exchange(reprompt);
          }
          charge = await chargeUsage(agent, turnUsage);

          if (result.status !== "finished") {
            errorKind = "run-error";
            lastError = `run ${result.status}: ${result.error?.message ?? "sem detalhe"}`;
          } else if (o.schema && !capture.submitted) {
            errorKind = "schema";
            lastError = `agente não entregou ${SUBMIT_TOOL} válido (${capture.lastError ?? "nenhuma chamada"})`;
          } else {
            const value = o.schema ? capture.value : (result.result ?? "");
            journal.record({ key, label, model: model.id, result: value, chargedCents: charge.charged, totalTokens: charge.usage.totalTokens });
            if (memoKey) memo.set(memoKey, value);
            endEvent(true);
            return value as T;
          }
        } catch (err) {
          const overCap = attemptCut.isCutBy(err);
          if (overCap) await attemptCut.stopped(); // let the cancelled run stop before its usage is read and anything else touches the cwd
          if (agent && !charge) charge = await chargeUsage(agent, turnUsage); // timeout/erro também custam
          lastError = err instanceof Error ? err.message : String(err);
          if (overCap) {
            // Over a token cap: the attempt fails as "budget" and is not retried. The run's cap ends the run, the step's cap only the step.
            errorKind = "budget";
            endEvent(false);
            throw err;
          }
          const code = (err as { code?: unknown } | undefined)?.code;
          if (err instanceof RunCancelledError) {
            errorKind = "cancelled";
            cancelledBy = err;
          } else if (typeof code === "string" && ACCOUNT_ERROR_CODES.has(code)) {
            errorKind = "exception";
            endEvent(false);
            accountError ??= new AccountAccessError(`O plano da conta não dá acesso ao Cursor SDK (${code}): ${lastError}`);
            throw accountError;
          } else if (err instanceof RateLimitError) {
            errorKind = "rate-limit";
            // Não retentável = teto de uso do plano ("Usage limit exceeded" na doc do SDK): não adianta tentar de novo.
            if (!err.isRetryable) {
              endEvent(false);
              throw new BudgetExceededError(`Limite de uso do Cursor atingido: ${err.message}`);
            }
            await sleep(2000 * 2 ** (attempt - 1));
          } else {
            errorKind = /^timeout/.test(lastError) ? "timeout" : "exception";
          }
        } finally {
          cutters.delete(attemptCut);
          live.delete(turnUsage); // idempotent: an attempt that never got to be charged must not keep counting
          step.tokens += turnUsage.totalTokens;
          if (agent) await agent[Symbol.asyncDispose]().catch(() => {});
        }
        if (cancelledBy) reverted = await revert();
        endEvent(false);
        if (cancelledBy) throw cancelledBy;
      }
      throw new StepFailedError(`etapa "${label}" falhou após ${attempts} tentativa(s): ${lastError}`);
    } finally {
      sem.release();
    }
  }

  const ctx: WorkflowContext<A> = {
    args,
    runId,
    cwd: opts.cwd,
    budget,
    agent: agentCall,
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
