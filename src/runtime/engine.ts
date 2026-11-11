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

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent,
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
import { Journal } from "./journal.js";
import { MemoStore, isReadOnly, repoState } from "./memo.js";
import { stateDir as runtimeStateDir } from "./state.js";
import { type Capture, SUBMIT_TOOL, repromptMessage, schemaInstruction, submitResultTool } from "./structured.js";
import type { AgentCallOptions, Budget, UsageTotals, WorkflowContext, WorkflowDefinition } from "./workflow.js";

/** Erro que encerra o run inteiro, inclusive dentro de parallel/pipeline (não vira null). */
export class FatalRunError extends Error {}
export class BudgetExceededError extends FatalRunError {}
/** A conta não tem acesso ao SDK (ex.: plano Free: `plan_required` já no Agent.create). Tentar de novo não adianta. */
export class AccountAccessError extends FatalRunError {}
/** Códigos de erro do SDK que dizem respeito à conta, não à etapa. */
const ACCOUNT_ERROR_CODES = new Set(["plan_required"]);
export class StepFailedError extends Error {}

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
  maxCents?: number | null;
  maxTokens?: number | null;
  /** Agentes simultâneos. Default 4 (o Cursor não documenta limite numérico; seja conservador). */
  concurrency?: number;
  /**
   * Camadas de configuração carregadas pelos agentes das etapas. Default ["project","team","mdm"]:
   * AGENTS.md, .cursor/rules, skills (.agents/skills, .cursor/skills, ...), hooks e MCP do projeto,
   * mais regras/hooks do time e hooks Enterprise (MDM). Remova "project" em repositórios não confiáveis.
   */
  settingSources?: SettingSource[];
  /** Onde ficam journal e estado. Default <cwd>/.workflows/runs. */
  stateDir?: string;
  onEvent?: (e: WorkflowEvent) => void;
  /**
   * Banco de métricas (SQLite). Default: ~/.cursor-workflows/metrics.db ($WF_METRICS_DB). `false` desliga;
   * WF_METRICS=off também. Falha ao gravar métricas nunca derruba o workflow.
   */
  metricsDb?: string | false;
}

/** Tokens de um turno do agente (evento `turn-ended` do SDK: soma de todos os passos do turno). */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

export type ErrorKind = "timeout" | "run-error" | "schema" | "rate-limit" | "exception";

export type WorkflowEvent =
  | { type: "log"; message: string }
  | { type: "phase"; title: string }
  | {
      type: "run-start";
      runId: string;
      workflow: string;
      /** Hash do código e da meta do workflow: compare métricas só entre versões iguais. */
      workflowHash: string;
      argsHash: string;
      repo: { name: string; hash: string };
    }
  | { type: "run-end"; runId: string; status: "finished" | "failed"; outcomeStatus?: string; error?: string }
  | {
      type: "step-start";
      attemptId: string;
      stepKey: string;
      label: string;
      phase?: string;
      model?: string;
      modelKey?: string;
      modelParams?: ModelSelection["params"];
      attempt: number;
      tools?: string[];
      settingSources: SettingSource[];
      promptHash: string;
      promptChars: number;
      /** Só quando WF_METRICS_STORE_PROMPTS=1. */
      prompt?: string;
    }
  /** Um turno do agente terminou (pode ter vários passos/chamadas ao modelo). */
  | { type: "turn"; attemptId: string; idx: number; steps: number; usage: TurnUsage }
  | {
      type: "step-end";
      attemptId: string;
      stepKey: string;
      label: string;
      phase?: string;
      attempt?: number;
      ok: boolean;
      /** De onde veio o resultado sem chamar a API: journal do run (resume) ou memo entre runs. */
      cached: false | "journal" | "memo";
      chargedCents: number;
      rawCents?: number;
      /** false = o Cursor ainda não tinha reportado custo; `wf metrics reconcile` completa depois. */
      costFinal?: boolean;
      model?: string;
      /** `RunResult.model.id`: o ID que o Cursor resolveu (alias → ID do catálogo). Com `default` (Auto), continua `default`. */
      resolvedModel?: string;
      modelKey?: string;
      usage?: UsageTotals;
      reasoningTokens?: number;
      errorKind?: ErrorKind;
      error?: string;
      schemaReprompts?: number;
      turns?: number;
      steps?: number;
      toolCalls?: Record<string, number>;
      summaries?: number;
      agentId?: string;
      usageRuns?: RunUsage[];
      durationMs?: number;
    }
  | { type: "metric"; name: string; value: number | string }
  | { type: "warning"; message: string };

export interface RunOutcome<R> {
  runId: string;
  status: "finished" | "failed";
  result?: R;
  error?: string;
  /** Custo do Cursor que o teto usa: soma, por tentativa, do maior entre `rawCostCents` e `chargedCents`. */
  spentCents: number;
  /** Soma de `chargedCents` (o valor cobrado; 0 para uso incluído no plano, BYOK e créditos). */
  chargedCents: number;
  spentTokens: number;
  /** Tokens por tipo. O input já inclui o cache (medido); cacheHitRatio = cacheRead / input (ver docs/08). */
  usage: UsageTotals & { cacheHitRatio: number | null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ajv = new Ajv({ allErrors: true, strict: false });

const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });

function addUsage(acc: UsageTotals, u: Partial<UsageTotals> | undefined): void {
  if (!u) return;
  acc.inputTokens += u.inputTokens ?? 0;
  acc.outputTokens += u.outputTokens ?? 0;
  acc.cacheReadTokens += u.cacheReadTokens ?? 0;
  acc.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  acc.totalTokens += u.totalTokens ?? 0;
}

function withRatio(u: UsageTotals): UsageTotals & { cacheHitRatio: number | null } {
  // Medido na API: inputTokens já inclui leitura e escrita de cache, e totalTokens = input + output.
  return { ...u, cacheHitRatio: u.inputTokens > 0 ? Math.round((u.cacheReadTokens / u.inputTokens) * 1000) / 1000 : null };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Modelo + params ordenados: "composer-2[reasoning_effort=low]". Esforço e contexto viram braços distintos. */
export function modelKey(m: ModelSelection | undefined): string | undefined {
  if (!m) return undefined;
  const params = [...(m.params ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((p) => `${p.id}=${p.value}`);
  return params.length || m.maxMode ? `${m.id}[${[...params, ...(m.maxMode ? ["max"] : [])].join(",")}]` : m.id;
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

export async function runWorkflow<A, R>(
  def: WorkflowDefinition<A, R>,
  args: A,
  opts: RunOptions,
): Promise<RunOutcome<R>> {
  const runId = opts.runId ?? newRunId(def.meta.name);
  // spentCents = Σ max(bruto, cobrado). O cobrado sozinho é 0 para uso incluído no plano e não protegeria nada.
  let spentCents = 0;
  let chargedCents = 0;
  let spentTokens = 0;
  const totals = emptyUsage();
  const outcome = (status: "finished" | "failed", extra: { result?: R; error?: string }): RunOutcome<R> => ({
    runId,
    status,
    ...extra,
    spentCents,
    chargedCents,
    spentTokens,
    usage: withRatio(totals),
  });

  if (def.meta.argsSchema) {
    const validate = ajv.compile(def.meta.argsSchema);
    if (!validate(args)) {
      return outcome("failed", { error: `args inválidos: ${ajv.errorsText(validate.errors)}` });
    }
  }

  // Métricas: o recorder é carregado só se ligado (importa node:sqlite sob demanda).
  let recorder: { record(e: WorkflowEvent): void; close(): void } | undefined;
  if (opts.metricsDb !== false && process.env.WF_METRICS !== "off") {
    try {
      const { createRecorder } = await import("../observability/recorder.js");
      recorder = await createRecorder(opts.metricsDb || undefined);
    } catch (err) {
      opts.onEvent?.({ type: "warning", message: `métricas desligadas: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const emit = (e: WorkflowEvent) => {
    try {
      recorder?.record(e);
    } catch (err) {
      opts.onEvent?.({ type: "warning", message: `falha ao gravar métrica: ${err instanceof Error ? err.message : String(err)}` });
    }
    opts.onEvent?.(e);
  };
  const storePrompts = process.env.WF_METRICS_STORE_PROMPTS === "1";
  emit({
    type: "run-start",
    runId,
    workflow: def.meta.name,
    workflowHash: sha(JSON.stringify(def.meta) + JSON.stringify(def.defaults ?? {}) + def.run.toString()).slice(0, 16),
    argsHash: sha(JSON.stringify(args ?? null)).slice(0, 16),
    repo: repoIdentity(opts.cwd),
  });

  process.env[INSIDE_WORKFLOW_ENV] = "1";
  const runsDir = opts.stateDir ?? runtimeStateDir(opts.cwd, "runs");
  const journal = new Journal(join(runsDir, runId, "journal.jsonl"));
  const memo = new MemoStore(opts.cwd);
  const sem = new Semaphore(opts.concurrency ?? 4);
  const settingSources = opts.settingSources ?? ["project", "team", "mdm"];
  let currentPhase: string | undefined;

  const budget: Budget = {
    maxCents: opts.maxCents ?? null,
    maxTokens: opts.maxTokens ?? null,
    spentCents: () => spentCents,
    chargedCents: () => chargedCents,
    spentTokens: () => spentTokens,
    remainingCents: () => (opts.maxCents == null ? Infinity : Math.max(0, opts.maxCents - spentCents)),
    usage: () => ({ ...totals }),
  };

  // Erro de conta (ex.: plan_required): registrado aqui para nenhuma etapa enfileirada começar depois dele.
  let accountError: AccountAccessError | undefined;

  function assertBudget(): void {
    if (accountError) throw accountError;
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

  /** send() com tolerância a AgentBusyError (a run anterior ainda fechando). */
  async function send(agent: SDKAgent, message: string, options?: SendOptions): Promise<Run> {
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

  async function waitWithTimeout(run: Run, ms: number): Promise<RunResult> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new StepFailedError(`timeout após ${ms} ms`));
      }, ms);
    });
    try {
      return await Promise.race([run.wait(), timeout]);
    } finally {
      clearTimeout(timer);
      // Espera o cancelamento terminar para a próxima tentativa não editar o mesmo cwd em paralelo.
      if (timedOut) await run.cancel().catch(() => {});
    }
  }

  async function agentCall<T>(prompt: string, callOpts: AgentCallOptions = {}): Promise<T> {
    const o: AgentCallOptions = { ...def.defaults, ...callOpts };
    const promptHash = sha(prompt).slice(0, 16);
    // Label padrão é um hash, não o começo do prompt: nada de conteúdo de issue/código nas métricas e logs.
    const label = o.label ?? `etapa-${promptHash.slice(0, 8)}`;
    const phase = o.phase ?? currentPhase;
    const sources = o.settingSources ?? settingSources;
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
    const cachedEnd = (from: "journal" | "memo") =>
      emit({ type: "step-end", attemptId: randomUUID(), stepKey: key, label, phase, ok: true, cached: from, chargedCents: 0, model: o.model?.id, modelKey: mKey });
    const cached = journal.get(key);
    if (cached) {
      cachedEnd("journal");
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
          cachedEnd("memo");
          return hit as T;
        }
      } else {
        emit({ type: "warning", message: `etapa "${label}": memo ignorado (cwd não é um repositório git com commit)` });
      }
    }
    if (!o.model) throw new StepFailedError(`etapa "${label}" sem modelo: defina opts.model ou defaults.model`);
    if (o.schema && o.schema.type !== "object") {
      throw new StepFailedError(`etapa "${label}": schema precisa ter type "object" na raiz (vira o inputSchema de uma tool)`);
    }
    const model = o.model;

    await sem.acquire();
    try {
      const attempts = 1 + (o.retries ?? 1);
      let lastError = "";
      for (let attempt = 1; attempt <= attempts; attempt++) {
        assertBudget();
        const attemptId = randomUUID();
        const startedAt = Date.now();
        emit({
          type: "step-start",
          attemptId,
          stepKey: key,
          label,
          phase,
          model: model.id,
          modelKey: mKey,
          modelParams: model.params,
          attempt,
          tools: o.tools,
          settingSources: sources,
          promptHash,
          promptChars: prompt.length,
          prompt: storePrompts ? prompt : undefined,
        });
        // Contadores alimentados pelo stream de deltas do SDK.
        const c = { turns: 0, steps: 0, stepsInTurn: 0, summaries: 0, reprompts: 0, toolCalls: {} as Record<string, number> };
        // Soma dos turn-ended desta tentativa: reserva de tokens quando getUsage() não responde.
        const turnUsage: UsageTotals & { reasoningTokens?: number } = emptyUsage();
        const sendOpts: SendOptions = {
          onDelta: ({ update }) => {
            switch (update.type) {
              case "step-completed":
                c.steps++;
                c.stepsInTurn++;
                break;
              case "tool-call-started": {
                const name = update.toolCall?.type ?? "unknown";
                c.toolCalls[name] = (c.toolCalls[name] ?? 0) + 1;
                break;
              }
              case "summary-completed":
                c.summaries++;
                break;
              case "turn-ended":
                if (update.usage) {
                  emit({ type: "turn", attemptId, idx: c.turns, steps: c.stepsInTurn, usage: update.usage });
                  const t = update.usage;
                  addUsage(turnUsage, { ...t, totalTokens: t.inputTokens + t.outputTokens }); // o cache já está no input
                  if (t.reasoningTokens) turnUsage.reasoningTokens = (turnUsage.reasoningTokens ?? 0) + t.reasoningTokens;
                }
                c.turns++;
                c.stepsInTurn = 0;
                break;
            }
          },
        };
        const capture: Capture = { value: undefined, submitted: false };
        let agent: SDKAgent | undefined;
        let charge: Charge | undefined;
        let errorKind: ErrorKind | undefined;
        let resolvedModel: string | undefined;
        const endEvent = (ok: boolean) =>
          emit({
            type: "step-end",
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
        try {
          agent = await Agent.create({
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
            local: {
              cwd: o.cwd ?? opts.cwd,
              settingSources: sources,
              sandboxOptions: o.sandbox ? { enabled: true } : undefined,
              customTools: o.schema ? { [SUBMIT_TOOL]: submitResultTool(o.schema, capture) } : undefined,
            },
          });
          let result = await waitWithTimeout(await send(agent, o.schema ? prompt + schemaInstruction() : prompt, sendOpts), o.timeoutMs ?? 20 * 60_000);
          resolvedModel = result.model?.id;
          // Saída estruturada: re-prompt na MESMA conversa até o modelo chamar submit_result com JSON válido.
          let schemaTries = o.schemaRetries ?? 2;
          while (o.schema && result.status === "finished" && !capture.submitted && schemaTries-- > 0) {
            c.reprompts++;
            result = await waitWithTimeout(await send(agent, repromptMessage(capture), sendOpts), o.timeoutMs ?? 20 * 60_000);
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
          if (agent && !charge) charge = await chargeUsage(agent, turnUsage); // timeout/erro também custam
          lastError = err instanceof Error ? err.message : String(err);
          const code = (err as { code?: unknown } | undefined)?.code;
          if (typeof code === "string" && ACCOUNT_ERROR_CODES.has(code)) {
            errorKind = "exception";
            endEvent(false);
            accountError ??= new AccountAccessError(`O plano da conta não dá acesso ao Cursor SDK (${code}): ${lastError}`);
            throw accountError;
          }
          if (err instanceof RateLimitError) {
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
          if (agent) await agent[Symbol.asyncDispose]().catch(() => {});
        }
        endEvent(false);
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
    async parallel(thunks) {
      return Promise.all(
        thunks.map((t) =>
          t().catch((err: unknown) => {
            if (err instanceof FatalRunError) throw err; // teto de custo ou conta sem acesso aborta o workflow inteiro
            emit({ type: "warning", message: `parallel: ${err instanceof Error ? err.message : String(err)}` });
            return null;
          }),
        ),
      );
    },
    async pipeline(items, ...stages) {
      return Promise.all(
        items.map(async (item, index) => {
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
      );
    },
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

  let final: RunOutcome<R>;
  try {
    final = outcome("finished", { result: await def.run(ctx) });
  } catch (err) {
    final = outcome("failed", { error: err instanceof Error ? err.message : String(err) });
  }
  const r = final.result as { status?: unknown } | undefined;
  emit({
    type: "run-end",
    runId,
    status: final.status,
    outcomeStatus: r && typeof r === "object" && typeof r.status === "string" ? r.status : undefined,
    error: final.error,
  });
  recorder?.close();
  return final;
}
