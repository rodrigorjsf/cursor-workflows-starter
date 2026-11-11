// Fake mínimo do @cursor/sdk: testa o controle de fluxo do engine sem rede nem conta Cursor.
// Ativado por tsconfig.test.json (paths: "@cursor/sdk" -> este arquivo).
export const calls: any[] = [];
/** Comportamento de cada send(), em ordem. Sem entrada: run "finished" com result "ok". */
export const script: Array<(o: any, msg: string, n: number) => any> = [];
export const stats = { active: 0, maxActive: 0, disposed: 0, usageReads: 0 };
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
export const costConfig: { raw: number | undefined; charged: number; modelId?: string; getUsageError?: string; createErrorCode?: string } = { raw: 9, charged: 7 };
export const Agent = {
  async getUsage(_agentId: string) {
    return { usage: { ...TURN_USAGE, totalTokens: 110 }, cost: { chargedCents: 7, rawCostCents: 9 }, runs: [] };
  },
  async create(o: any) {
    calls.push(o);
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
        const behave = script.shift() ?? (() => ({ status: "finished", result: "ok" }));
        const r = await behave(o, msg, n++);
        for (const update of r?.deltas ?? DEFAULT_DELTAS) {
          if (update.type === "turn-ended" && update.usage) turnUsages.push(update.usage);
          await options?.onDelta?.({ update });
        }
        if (r?.hang) return { cancel: async () => {}, wait: () => new Promise(() => {}) };
        return { cancel: async () => {}, wait: async () => ({ id: "r", status: "finished", model: o.model, ...r }) };
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
export const Cursor = {};
