// Fake mínimo do @cursor/sdk: testa o controle de fluxo do engine sem rede nem conta Cursor.
// Ativado por tsconfig.test.json (paths: "@cursor/sdk" -> este arquivo).
/** Set when this module is loaded: lets a test prove that a module graph never imports the SDK. */
(globalThis as { __fakeSdkLoaded?: boolean }).__fakeSdkLoaded = true;
export const calls: any[] = [];
/** Comportamento de cada send(), em ordem. Sem entrada: run "finished" com result "ok". */
export const script: Array<(o: any, msg: string, n: number) => any> = [];
/**
 * `cancels`: Run.cancel() calls (not on `hang` runs). `cancelled`: `hang` runs ended by cancel(). `turnsDelivered`:
 * turn-ended deltas that reached onDelta on live runs. `sends`: Agent.send() calls.
 */
export const stats = { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, cancelled: 0, turnsDelivered: 0, sends: 0 };
export class CursorAgentError extends Error {
  isRetryable = false;
}
export class RateLimitError extends CursorAgentError {}
export class AgentBusyError extends CursorAgentError {}
export class ConfigurationError extends CursorAgentError {}
// Como a API: inputTokens (100) já inclui cacheRead (60) e cacheWrite (20); totalTokens = input + output.
const TURN_USAGE = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 20 };
/** Deltas padrão de um send(): 2 passos, 1 tool call (read) e o fim do turno com uso. */
const DEFAULT_DELTAS = [
  { type: "step-completed", stepId: 1, stepDurationMs: 5 },
  { type: "tool-call-started", callId: "c1", modelCallId: "m1", toolCall: { type: "read" } },
  { type: "step-completed", stepId: 2, stepDurationMs: 5 },
  { type: "turn-ended", usage: TURN_USAGE },
];
/** Custo devolvido por getUsage() (mude nos testes). */
export const costConfig: {
  raw: number | undefined;
  charged: number;
  modelId?: string;
  getUsageError?: string;
  createErrorCode?: string;
  createHang?: boolean;
  createDelayMs?: number;
  /**
   * The client's wait limit on a cloud run, in ms (the real SDK gives up after two hours): a `wait()` that is still waiting then
   * resolves with status "error" and the SDK's message, while the run goes on in the cloud. `undefined` = no limit.
   */
  cloudWaitLimitMs?: number;
  /** `Agent.listRuns` answers newest first instead of oldest first (the real API's order is not documented). */
  listNewestFirst?: boolean;
  /** The next this many `Agent.listRuns` calls fail like a server that is down (503): a lookup that does not say "not found". */
  lookupFailures?: number;
  /** Holds the creation of the agents it answers for (it gets the create options) until the promise settles; `undefined` = not held. */
  createGate?: (options: any) => Promise<unknown> | undefined;
} = { raw: 9, charged: 7 };
/** A value that satisfies a JSON Schema: the first `enum` member, the `const`, or the plainest value of the type. */
function sampleOf(schema: any): unknown {
  if (schema?.const !== undefined) return schema.const;
  if (schema?.enum) return schema.enum[0];
  switch (schema?.type) {
    case "object":
      return Object.fromEntries((schema.required ?? []).map((key: string) => [key, sampleOf(schema.properties?.[key])]));
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () => sampleOf(schema.items));
    case "string":
      return "ok";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    default:
      return null;
  }
}
/**
 * `FAKE_SDK_AUTO_SUBMIT=1`: a structured step is answered with a sample of its schema, as a model that follows the prompt
 * would. For spawned processes, which cannot reach the process-local `script`. Off by default: most tests choose the answer.
 */
function autoSubmit(options: any) {
  const tool = options.local?.customTools?.submit_result;
  if (process.env.FAKE_SDK_AUTO_SUBMIT && tool) tool.execute(sampleOf(tool.inputSchema), {});
}
/** What the cloud keeps for a cloud agent, whoever is connected to it. A client object is only a handle on this. */
interface ServerRun {
  id: string;
  agentId: string;
  createdAt: number;
  status: "running" | "finished" | "error" | "cancelled";
  /** The run's end, once there is one. */
  done: Promise<any>;
  /** Ends the run with `result`; the first end wins. */
  settle(result: any): void;
  /** What the run was scripted as: `cancel()` of a run that does not end by itself. */
  raw?: any;
}
interface AgentState {
  agentId: string;
  /** The options the agent was created with: what a script sees as `o`. */
  options: any;
  /** Messages sent so far (the next one's number). */
  n: number;
  turnUsages: Array<typeof TURN_USAGE>;
  runs: ServerRun[];
}
/**
 * The cloud agents the server knows. Like the real SDK, `Agent.create` mints an id and the server learns the agent when
 * its first message is sent: until then `resume` and the run lookups answer "not found".
 */
const cloudServer = new Map<string, AgentState>();
let runCounter = 0;
/** Clients born before this number are dead: a process that crashed never hears from the cloud again. */
let clientEpoch = 0;
/** The ids `Agent.resume` was asked for, and the run lookups made. */
export const resumes: string[] = [];
export const lookups: Array<{ kind: "listRuns" | "getRun"; agentId: string; runId?: string }> = [];
/** Forgets what the fake cloud knows (call it between tests). */
export function resetCloud() {
  cloudServer.clear();
  resumes.length = 0;
  lookups.length = 0;
}
/** The process that talked to the cloud so far dies: none of its agents and runs hears back, and cancelling does nothing. */
export const killCloudClients = () => void clientEpoch++;
/** The cloud agent finishes its running run by itself (it kept working while the machine was away). */
export function finishCloudRun(agentId: string, result: Record<string, unknown> = { result: "ok" }) {
  const run = cloudServer.get(agentId)?.runs.findLast((r) => r.status === "running");
  if (!run) throw new Error(`fake SDK: ${agentId} has no running run`);
  run.settle({ id: run.id, status: "finished", ...result });
}
/** The cloud forgets the agent (it was deleted, or the first message never reached it). */
export const forgetCloudAgent = (agentId: string) => void cloudServer.delete(agentId);
/** What a cloud agent's runs are, as the server has them. */
export const cloudRunsOf = (agentId: string) => (cloudServer.get(agentId)?.runs ?? []).map(({ id, status }) => ({ id, status }));
/** Puts an agent on the server with the given runs, the way an earlier session left it. */
export function seedCloudAgent(agentId: string, runs: Array<{ status?: ServerRun["status"]; result?: string }>, options: any = { cloud: {} }) {
  const state: AgentState = { agentId, options, n: runs.length, turnUsages: [], runs: [] };
  for (const { status = "finished", result = "ok" } of runs) {
    const run = serverRun(state, undefined);
    if (status !== "running") run.settle({ id: run.id, status, result });
  }
  cloudServer.set(agentId, state);
}

function notFound(what: string) {
  return Object.assign(new ConfigurationError(`${what} not found`), { status: 404 });
}

function serverRun(state: AgentState, raw: any): ServerRun {
  let settle!: (result: any) => void;
  const done = new Promise<any>((resolve) => (settle = resolve));
  const run: ServerRun = {
    id: `run-${++runCounter}`,
    agentId: state.agentId,
    createdAt: Date.now() + runCounter, // distinct and increasing
    status: "running",
    done,
    settle: (result) => {
      if (run.status !== "running") return;
      run.status = result.status;
      settle(result);
    },
    raw,
  };
  state.runs.push(run);
  return run;
}

const WAIT_LIMIT = Symbol("wait limit");
/** A client's handle on a cloud run. Its status is the server's, until its own `wait()` gives up. */
function cloudHandle(run: ServerRun) {
  const born = clientEpoch;
  const alive = () => born === clientEpoch;
  let gaveUp = false;
  const timedOut = () => ({ id: run.id, status: "error", error: { message: "Timed out waiting for the cloud run to finish." } });
  return {
    id: run.id,
    agentId: run.agentId,
    createdAt: run.createdAt,
    get status() {
      return gaveUp ? "error" : run.status;
    },
    async wait() {
      if (gaveUp) return timedOut();
      const limit = costConfig.cloudWaitLimitMs;
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([run.done, limit === undefined ? new Promise<never>(() => {}) : new Promise((r) => (timer = setTimeout(() => r(WAIT_LIMIT), limit)))]);
      clearTimeout(timer);
      if (!alive()) await new Promise(() => {});
      if (result === WAIT_LIMIT) {
        gaveUp = true;
        return timedOut();
      }
      return result;
    },
    async cancel() {
      if (!alive() || run.status !== "running") return;
      await run.raw?.cancel?.();
      run.settle({ id: run.id, status: "cancelled" });
    },
  };
}

/** The client object of an agent. `state` is the agent's own, or the server's when the agent is a cloud one. */
function agentOf(state: AgentState) {
  const o = state.options;
  const born = clientEpoch;
  return {
    agentId: state.agentId,
    async send(msg: string, options?: any) {
      if (born !== clientEpoch) await new Promise(() => {}); // the client is dead
      stats.sends++;
      if (o.cloud && !cloudServer.has(state.agentId)) cloudServer.set(state.agentId, state); // the first message creates the agent on the server
      // `script` is process-local; a test that spawns a CLI or an MCP server steers the fake through the prompt instead.
      const behave =
        script.shift() ??
        (() => {
          if (msg.includes("[fake:hang]")) return { hang: true, cancelDelayMs: msg.includes("[fake:slow-cancel]") ? 5000 : 0 };
          autoSubmit(o);
          return { status: "finished", result: "ok" };
        });
      const r = await behave(o, msg, state.n++);
      /** A cloud run is on the server: the client gets a handle on it. */
      const out = (raw: any) => {
        if (!o.cloud) return raw;
        const run = serverRun(state, raw);
        raw.wait().then(
          (result: any) => run.settle(result),
          (err: unknown) => run.settle({ id: run.id, status: "error", error: { message: err instanceof Error ? err.message : String(err) } }),
        );
        return cloudHandle(run);
      };
      /** One delta reaches the caller; a turn's usage also counts toward the agent's total (what getUsage() sums). */
      const deliver = async (update: any, live: boolean) => {
        if (update.type === "turn-ended" && update.usage) {
          state.turnUsages.push(update.usage);
          if (live) stats.turnsDelivered++;
        }
        await options?.onDelta?.({ update });
      };
      if (r?.live) {
        // Opt-in, like the real SDK: send() hands back the run first and the deltas stream after it, one per macrotask,
        // until the run is cancelled (nothing is delivered after cancel()). The result is "cancelled" in that case.
        // `gate` (a promise) holds the first delta until it settles: a test uses it to let parallel steps all have a run before any turn lands.
        let cancelled = false;
        const streamed = (async () => {
          await r.gate;
          for (const update of r.deltas ?? DEFAULT_DELTAS) {
            await new Promise((resolve) => setImmediate(resolve));
            if (cancelled) return;
            await deliver(update, true);
          }
        })();
        return out({
          cancel: async () => {
            if (!cancelled) stats.cancels++;
            cancelled = true;
            await streamed;
          },
          wait: async () => {
            await streamed;
            if (r.rejectWait) throw r.rejectWait; // the run fails after its turns, e.g. with a RateLimitError
            if (cancelled && r.stuckAfterCancel) await new Promise(() => {}); // a wait() that never settles once cancelled
            return { id: "r", status: "finished", model: o.model, ...r, ...(cancelled ? { status: "cancelled" } : {}) };
          },
        });
      }
      for (const update of r?.deltas ?? DEFAULT_DELTAS) await deliver(update, false);
      if (r?.hang) {
        // A run that does not end by itself. `cancel()` ends it, as in the SDK: `wait()` then resolves with status "cancelled".
        let end!: (result: any) => void;
        const ended = new Promise((resolve) => (end = resolve));
        return out({
          async cancel() {
            if (r.cancelDelayMs) await new Promise((resolve) => setTimeout(resolve, r.cancelDelayMs)); // a cancellation that takes its time
            stats.cancelled++;
            end({ id: "r", status: "cancelled", model: o.model });
          },
          wait: () => ended,
        });
      }
      return out({ cancel: async () => void stats.cancels++, wait: async () => ({ id: "r", status: "finished", model: o.model, ...r }) });
    },
    async getUsage() {
      stats.usageReads++;
      if (costConfig.getUsageError) {
        // Como o SDK para agentes locais com uso ainda não liberado: 403 feature_unavailable.
        throw Object.assign(new Error(costConfig.getUsageError), { code: "feature_unavailable" });
      }
      const cost = costConfig.raw === undefined ? undefined : { chargedCents: costConfig.charged, rawCostCents: costConfig.raw };
      // Como no SDK: o total do agente é a soma dos turnos que ele emitiu (ou o uso padrão, se nenhum).
      // An agent that never called send() used nothing.
      const sum = (state.turnUsages.length || state.n === 0 ? state.turnUsages : [TURN_USAGE]).reduce(
        (a, u) => ({
          inputTokens: a.inputTokens + u.inputTokens,
          outputTokens: a.outputTokens + u.outputTokens,
          cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens,
          cacheWriteTokens: a.cacheWriteTokens + u.cacheWriteTokens,
        }),
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      );
      const usage = { ...sum, totalTokens: sum.inputTokens + sum.outputTokens };
      return { usage, cost, runs: [{ runId: `usage-${stats.usageReads}`, usage, cost }] };
    },
    async [Symbol.asyncDispose]() {
      stats.active--;
      stats.disposed++;
    },
    close() {},
  };
}

export const Agent = {
  async getUsage(_agentId: string) {
    return { usage: { ...TURN_USAGE, totalTokens: 110 }, cost: { chargedCents: 7, rawCostCents: 9 }, runs: [] };
  },
  async create(o: any) {
    calls.push(o);
    if (o.cloud) {
      // Cloud mode, as the SDK 1.3.1 type declarations say: a cloud agent rejects tool allowlists, a replaced system prompt and
      // custom tools (they live under `local`). It sees only a repository's remote ref, so `cloud.repos` names where it starts.
      for (const option of ["tools", "disallowedTools", "systemPrompt"]) {
        if (o[option] !== undefined) throw new ConfigurationError(`\`${option}\` is not supported on cloud agents`);
      }
      if (o.local?.customTools) throw new ConfigurationError("custom tools are not supported on cloud agents");
    }
    if (costConfig.createHang) return new Promise(() => {}); // a creation that never answers
    if (costConfig.createDelayMs) await new Promise((r) => setTimeout(r, costConfig.createDelayMs)); // a slow one
    await costConfig.createGate?.(o); // a slow one, chosen by agent
    if (costConfig.createErrorCode) {
      // Como o SDK no plano Free: a validação local do modelo chama GET /v1/models e recebe 403.
      throw Object.assign(new CursorAgentError(`[${costConfig.createErrorCode}] Cloud Agent is not available for free users. Please upgrade to Pro.`), { code: costConfig.createErrorCode, status: 403 });
    }
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    return agentOf({ agentId: `${o.cloud ? "bc" : "agent"}-${calls.length}`, options: o, n: 0, turnUsages: [], runs: [] });
  },
  /** A cloud agent again, from its id: a new client object on what the server has (nothing is asked of the network yet, as in the SDK). */
  async resume(agentId: string, options: any = {}) {
    resumes.push(agentId);
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    return agentOf(cloudServer.get(agentId) ?? { agentId, options: { ...options, cloud: {} }, n: 0, turnUsages: [], runs: [] });
  },
  /** The runs of a cloud agent, oldest first unless `costConfig.listNewestFirst` (the real API's order is not documented: callers must not depend on it). */
  async listRuns(agentId: string, _options?: any) {
    lookups.push({ kind: "listRuns", agentId });
    if (costConfig.lookupFailures) {
      costConfig.lookupFailures--;
      throw Object.assign(new CursorAgentError("service unavailable"), { status: 503, isRetryable: true });
    }
    const state = cloudServer.get(agentId);
    if (!state) throw notFound(`agent ${agentId}`);
    const items = state.runs.map(cloudHandle);
    return { items: costConfig.listNewestFirst ? items.reverse() : items };
  },
  async getRun(runId: string, options: { agentId: string }) {
    lookups.push({ kind: "getRun", agentId: options.agentId, runId });
    const run = cloudServer.get(options.agentId)?.runs.find((r) => r.id === runId);
    if (!run) throw notFound(`run ${runId}`);
    return cloudHandle(run);
  },
};
/**
 * Account and catalog, steered through the environment (a spawned `wf` shares nothing else with the test):
 * `FAKE_SDK_LOGGED_OUT=1` makes every call fail like a rejected key, with a message that carries the key it was given;
 * `FAKE_SDK_MODELS=a,b` is the catalog, by id (default: the models the built-in workflows use).
 */
const DEFAULT_CATALOG = ["composer-2.5", "grok-4.7"];
const assertLoggedIn = () => {
  if (process.env.FAKE_SDK_LOGGED_OUT) throw new Error(`fake SDK: not logged in (key "${process.env.CURSOR_API_KEY ?? "none"}")`);
};
export const Cursor = {
  async me() {
    assertLoggedIn();
    return { apiKeyName: "fake-key", userEmail: "dev@example.com", createdAt: "2026-01-01T00:00:00.000Z" };
  },
  models: {
    async list() {
      assertLoggedIn();
      return (process.env.FAKE_SDK_MODELS?.split(",") ?? DEFAULT_CATALOG).map((id) => ({ id, displayName: id, aliases: [`${id}-alias`] }));
    },
  },
};
