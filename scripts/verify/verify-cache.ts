// WHAT: Workflow that runs sibling agents in parallel and in sequence with an identical prefix and reports their
//   cache-read tokens.
// WHY: Whether sibling agents reuse a prompt-cache prefix is undocumented for the Cursor SDK; this measures it.
// WHEN: On a new account or after an SDK upgrade, to refresh the cache numbers in
//   docs/operating/02-custos-e-cache.md.
// HOW: `WORKFLOWS_DIR=scripts/verify npm run wf -- run verify-cache --cwd <probe-repo> --max-tokens 100000` (see
//   scripts/verify/README.md).

// Verificação real: agentes irmãos aproveitam o prefixo em cache? (ver docs/research/verificacoes-locais.md §8)
import { defineWorkflow } from "../../packages/runtime/src/runtime/workflow.js";

const PROMPT = "Read README.md, AGENTS.md and package.json. Answer in one line: how many lines each file has.";
const OPTS = { tools: ["read"], settingSources: [] as [] };

export default defineWorkflow({
  meta: { name: "verify-cache", description: "Verification: prompt cache between sibling agents (parallel and in sequence)." },
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
