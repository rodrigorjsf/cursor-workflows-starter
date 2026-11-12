// The cheapest workflow that proves the whole path: chat -> MCP -> detached job -> Cursor SDK -> structured result.
// One step, no tools, no project context, a model the paid plans include, and a low token cap. It is the third of the
// seven Cursor IDE validation scenarios (`scripts/verify/validate-cursor-ide.sh`, skills/cursor-workflows-setup); the
// seventh watches a `smoke` run in the dashboard.
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

const PROMPT = "Kit smoke test. Do not read or change anything. Call the submit_result tool with answer equal to \"pong\".";

export default defineWorkflow({
  meta: {
    name: "smoke",
    description: "Cheap smoke test: one agent step with a structured result, on a model the plan includes and with a low token cap.",
    whenToUse: "When the user asks to test or validate the kit, the MCP server or the login, before running a real workflow.",
    phases: [{ title: "Ping" }],
    roles: [{ name: "ping", description: "The only step: returns the structured result.", cloud: "ok", defaults: { model: COMPOSER, settingSources: [] } }],
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
