// The cheapest workflow that proves the whole path: chat -> MCP -> detached job -> Cursor SDK -> structured result.
// One step, no tools, no project context, a model the paid plans include, and a low token cap. It is the third of the
// six Cursor IDE validation scenarios (`scripts/verify/validate-cursor-ide.sh`, skills/cursor-workflows-setup).
//
// The answer is fixed (`pong`) and checked by the schema, not by the workflow: `submit_result` refuses any other value
// to the agent, so a run that finishes has really gone through the SDK and back. A run that cannot (no login, a model
// outside the account's catalog, an agent that never calls the tool) fails with the reason instead of passing.
//
// Cost: 21,628 tokens on `composer-2.5`, measured against the real API on 2026-11-12 (about 16 thousand of them read
// from the cache, the rest the SDK's own prompt and the schema tool). The cap of 50 thousand leaves room for one
// correction of the answer and stops anything stranger. Accounts where `composer-2.5` is not included swap the model of
// the `ping` role in the config (`workflows.smoke.roles.ping.model`) or with `WF_MODEL_PING`.

import type { ModelSelection } from "@cursor/sdk";
import { defineWorkflow } from "../src/runtime/workflow.js";

const COMPOSER: ModelSelection = { id: "composer-2.5" };

const ANSWER_SCHEMA = {
  type: "object",
  required: ["answer"],
  additionalProperties: false,
  properties: { answer: { enum: ["pong"] } },
};

const PROMPT = "Teste de fumaça do kit. Não leia nem altere nada. Chame a tool submit_result com answer igual a \"pong\".";

export default defineWorkflow({
  meta: {
    name: "smoke",
    description: "Teste de fumaça barato: uma etapa de agente com resultado estruturado, num modelo incluído no plano e com teto de tokens baixo.",
    whenToUse: "Quando o usuário pedir para testar ou validar o kit, o servidor MCP ou o login, antes de rodar um workflow de verdade.",
    phases: [{ title: "Ping" }],
    roles: [{ name: "ping", description: "A única etapa: devolve o resultado estruturado.", cloud: "ok", defaults: { model: COMPOSER, settingSources: [] } }],
    argsSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  defaults: { timeoutMs: 3 * 60_000, retries: 0, schemaRetries: 1 },
  budget: { maxTokens: 50_000 },

  async run(ctx) {
    ctx.phase("Ping");
    const { answer } = await ctx.agent<{ answer: string }>(PROMPT, { label: "ping", role: "ping", tools: [], schema: ANSWER_SCHEMA });
    return { status: "ok", answer, tokens: ctx.budget.spentTokens() };
  },
});
