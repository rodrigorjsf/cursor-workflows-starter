// Fake mínimo do @cursor/sdk: testa o controle de fluxo do engine sem rede nem conta Cursor.
// Ativado por tsconfig.test.json (paths: "@cursor/sdk" -> este arquivo).
export const calls: any[] = [];
/** Comportamento de cada send(), em ordem. Sem entrada: run "finished" com result "ok". */
export const script: Array<(o: any, msg: string, n: number) => any> = [];
/**
 * `cancels`: Run.cancel() calls (not on `hang` runs). `cancelled`: `hang` runs ended by cancel(). `turnsDelivered`:
 * turn-ended deltas that reached onDelta on live runs.
 */
export const stats = { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, cancelled: 0, turnsDelivered: 0 };
export class CursorAgentError extends Error {
  isRetryable = false;
}
export class RateLimitError extends CursorAgentError {}
export class AgentBusyError extends CursorAgentError {}
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
export const costConfig: { raw: number | undefined; charged: number; modelId?: string; getUsageError?: string; createErrorCode?: string; createHang?: boolean; createDelayMs?: number } = { raw: 9, charged: 7 };
export const Agent = {
  async getUsage(_agentId: string) {
    return { usage: { ...TURN_USAGE, totalTokens: 110 }, cost: { chargedCents: 7, rawCostCents: 9 }, runs: [] };
  },
  async create(o: any) {
    calls.push(o);
    if (costConfig.createHang) return new Promise(() => {}); // a creation that never answers
    if (costConfig.createDelayMs) await new Promise((r) => setTimeout(r, costConfig.createDelayMs)); // a slow one
    if (costConfig.createErrorCode) {
      // Como o SDK no plano Free: a validação local do modelo chama GET /v1/models e recebe 403.
      throw Object.assign(new CursorAgentError(`[${costConfig.createErrorCode}] Cloud Agent is not available for free users. Please upgrade to Pro.`), { code: costConfig.createErrorCode, status: 403 });
    }
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    let n = 0;
    const turnUsages: Array<typeof TURN_USAGE> = [];
    return {
      agentId: `agent-${calls.length}`,
      async send(msg: string, options?: any) {
        // `script` is process-local; a test that spawns a CLI or an MCP server steers the fake through the prompt instead.
        const behave =
          script.shift() ??
          (() => (msg.includes("[fake:hang]") ? { hang: true, cancelDelayMs: msg.includes("[fake:slow-cancel]") ? 5000 : 0 } : { status: "finished", result: "ok" }));
        const r = await behave(o, msg, n++);
        /** One delta reaches the caller; a turn's usage also counts toward the agent's total (what getUsage() sums). */
        const deliver = async (update: any, live: boolean) => {
          if (update.type === "turn-ended" && update.usage) {
            turnUsages.push(update.usage);
            if (live) stats.turnsDelivered++;
          }
          await options?.onDelta?.({ update });
        };
        if (r?.live) {
          // Opt-in, like the real SDK: send() hands back the run first and the deltas stream after it, one per macrotask,
          // until the run is cancelled (nothing is delivered after cancel()). The result is "cancelled" in that case.
          let cancelled = false;
          const streamed = (async () => {
            for (const update of r.deltas ?? DEFAULT_DELTAS) {
              await new Promise((resolve) => setImmediate(resolve));
              if (cancelled) return;
              await deliver(update, true);
            }
          })();
          return {
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
          };
        }
        for (const update of r?.deltas ?? DEFAULT_DELTAS) await deliver(update, false);
        if (r?.hang) {
          // A run that does not end by itself. `cancel()` ends it, as in the SDK: `wait()` then resolves with status "cancelled".
          let end!: (result: any) => void;
          const ended = new Promise((resolve) => (end = resolve));
          return {
            async cancel() {
              if (r.cancelDelayMs) await new Promise((resolve) => setTimeout(resolve, r.cancelDelayMs)); // a cancellation that takes its time
              stats.cancelled++;
              end({ id: "r", status: "cancelled", model: o.model });
            },
            wait: () => ended,
          };
        }
        return { cancel: async () => void stats.cancels++, wait: async () => ({ id: "r", status: "finished", model: o.model, ...r }) };
      },
      async getUsage() {
        stats.usageReads++;
        if (costConfig.getUsageError) {
          // Como o SDK para agentes locais com uso ainda não liberado: 403 feature_unavailable.
          throw Object.assign(new Error(costConfig.getUsageError), { code: "feature_unavailable" });
        }
        const cost = costConfig.raw === undefined ? undefined : { chargedCents: costConfig.charged, rawCostCents: costConfig.raw };
        // Como no SDK: o total do agente é a soma dos turnos que ele emitiu (ou o uso padrão, se nenhum).
        const sum = (turnUsages.length ? turnUsages : [TURN_USAGE]).reduce(
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
