// WHAT: Workflow with three steps that exercise structured output: a plain schema, an invalid answer the agent must
//   correct, and a missing submit_result.
// WHY: Structured output goes through a custom submit_result tool and engine re-prompts; this checks both against
//   the real API.
// WHEN: On a new account or after an SDK upgrade, to re-check structured output.
// HOW: `WORKFLOWS_DIR=scripts/verify npm run wf -- run verify-structured --cwd <probe-repo> --max-tokens 150000`
//   (see scripts/verify/README.md).

// Verificação real: saída estruturada via submit_result (ver docs/research/verificacoes-locais.md §7).
import { defineWorkflow } from "../../packages/runtime/src/runtime/workflow.js";

const NAME_SCHEMA = { type: "object", required: ["name", "version"], properties: { name: { type: "string" }, version: { type: "string" } } };
const FILES_SCHEMA = { type: "object", required: ["files"], properties: { files: { type: "array", minItems: 3, items: { type: "string" } } } };
const WORD_SCHEMA = { type: "object", required: ["word"], properties: { word: { type: "string" } } };

export default defineWorkflow({
  meta: { name: "verify-structured", description: "Verificação: submit_result, correção de JSON inválido e re-prompt do engine." },
  defaults: { model: { id: process.env.WF_VERIFY_MODEL ?? "composer-2.5" }, timeoutMs: 5 * 60_000, retries: 0 },
  async run(ctx) {
    const a = await ctx.agent("Leia o package.json deste repositório e devolva o name e a version.", { label: "a-simples", tools: ["read"], schema: NAME_SCHEMA });
    const b = await ctx.agent(
      'Primeiro chame submit_result exatamente com {"files": ["README.md"]}. Se a ferramenta recusar, corrija conforme a mensagem de erro dela usando arquivos que existem na raiz do repositório.',
      { label: "b-invalido-depois-corrige", tools: ["read", "ls"], schema: FILES_SCHEMA },
    );
    const c = await ctx.agent("Responda apenas com o texto 'pronto'. Não chame nenhuma ferramenta nesta mensagem.", { label: "c-sem-submit", tools: [], schema: WORD_SCHEMA, schemaRetries: 2 });
    return { status: "done", a, b, c };
  },
});
