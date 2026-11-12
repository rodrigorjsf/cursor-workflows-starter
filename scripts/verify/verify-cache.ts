// Verificação real: agentes irmãos aproveitam o prefixo em cache? (ver docs/research/verificacoes-locais.md §8)
import { defineWorkflow } from "../../packages/runtime/src/runtime/workflow.js";

const PROMPT = "Leia README.md, AGENTS.md e package.json. Responda em uma linha: quantas linhas tem cada arquivo.";
const OPTS = { tools: ["read"], settingSources: [] as [] };

export default defineWorkflow({
  meta: { name: "verify-cache", description: "Verificação: cache de prompt entre agentes irmãos (paralelo e sequência)." },
  defaults: { model: { id: process.env.WF_VERIFY_MODEL ?? "composer-2.5" }, timeoutMs: 5 * 60_000, retries: 0 },
  async run(ctx) {
    ctx.phase("paralelo");
    const par = await ctx.parallel([() => ctx.agent(PROMPT, { ...OPTS, label: "par-1" }), () => ctx.agent(PROMPT, { ...OPTS, label: "par-2" })]);
    ctx.phase("sequencial");
    const s1 = await ctx.agent(PROMPT, { ...OPTS, label: "seq-1" });
    const s2 = await ctx.agent(PROMPT, { ...OPTS, label: "seq-2" });
    return { status: "done", par, s1, s2 };
  },
});
