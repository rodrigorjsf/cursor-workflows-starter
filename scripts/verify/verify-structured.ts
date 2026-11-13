// WHAT: Workflow with three steps that exercise structured output: a plain schema, an invalid answer the agent must
//   correct, and a missing submit_result.
// WHY: Structured output goes through a custom submit_result tool and engine re-prompts; this checks both against
//   the real API.
// WHEN: On a new account or after an SDK upgrade, to re-check structured output.
// HOW: `WORKFLOWS_DIR=scripts/verify npm run wf -- run verify-structured --cwd <probe-repo> --max-tokens 150000 --max-cents 25`
//   (see scripts/verify/README.md).

// Verificação real: saída estruturada via submit_result (ver docs/research/verificacoes-locais.md §7).
import { defineWorkflow } from "../../packages/runtime/src/runtime/workflow.js";

const NAME_SCHEMA = { type: "object", required: ["name", "version"], properties: { name: { type: "string" }, version: { type: "string" } } };
const FILES_SCHEMA = { type: "object", required: ["files"], properties: { files: { type: "array", minItems: 3, items: { type: "string" } } } };
const WORD_SCHEMA = { type: "object", required: ["word"], properties: { word: { type: "string" } } };

export default defineWorkflow({
  meta: { name: "verify-structured", description: "Verification: submit_result, fixing invalid JSON and the engine's re-prompt." },
  defaults: { model: { id: process.env.WF_VERIFY_MODEL ?? "composer-2.5" }, timeoutMs: 5 * 60_000, retries: 0 },
  async run(ctx) {
    const a = await ctx.agent("Read this repository's package.json and return its name and version.", { label: "a-simple", tools: ["read"], schema: NAME_SCHEMA });
    const b = await ctx.agent(
      'First call submit_result with exactly {"files": ["README.md"]}. If the tool refuses it, fix it as its error message says, using files that exist at the root of the repository.',
      { label: "b-invalid-then-fixed", tools: ["read", "ls"], schema: FILES_SCHEMA },
    );
    const c = await ctx.agent("Answer only with the text 'done'. Do not call any tool in this message.", { label: "c-no-submit", tools: [], schema: WORD_SCHEMA, schemaRetries: 2 });
    return { status: "done", a, b, c };
  },
});
