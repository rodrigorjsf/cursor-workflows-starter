// WHAT: Workflow that asks two agents (with and without settingSources) what instructions, hooks and MCP tools they
//   received.
// WHY: It proves which project context reaches a step agent and that the recursion guard hides start_workflow from
//   it.
// WHEN: On a new account or after an SDK upgrade, to re-check what settingSources loads.
// HOW: Run it on the repo from scripts/verify/setup-probe-repo.sh: `WORKFLOWS_DIR=scripts/verify npm run wf -- run
//   verify-context --cwd <probe-repo> --max-tokens 120000`.

// Verificação real: o que settingSources carrega em runs locais e a guarda contra recursão
// (ver docs/research/verificacoes-locais.md §7). Rode sobre o repositório criado por setup-probe-repo.sh.
import { defineWorkflow } from "../../packages/runtime/src/runtime/workflow.js";

const SCHEMA = {
  type: "object",
  required: ["marker", "mcpTools", "echoOutput", "blockedCommand", "insideEnv"],
  properties: {
    marker: { type: "string", description: "the verification word from the project instructions, or NONE" },
    mcpTools: { type: "array", items: { type: "string" }, description: "names of the MCP tools available to you" },
    echoOutput: { type: "string" },
    blockedCommand: { type: "string", description: "executed | blocked, with the message you received" },
    insideEnv: { type: "string", description: "the exact output of the last command" },
  },
};
const PROMPT =
  "Do not read any file. 1) What is the verification word defined in the project instructions you received? If you received none, answer NONE. " +
  "2) List the names of all MCP tools available to you. 3) Run `echo hook-ok` in the shell and report the output. " +
  "4) Run `echo forbidden-by-claude` in the shell and say whether it was executed or blocked, with the message you received. " +
  "5) Run `echo inside=$WF_INSIDE_WORKFLOW` in the shell and report the exact output.";

export default defineWorkflow({
  meta: { name: "verify-context", description: "Verification: AGENTS.md, Cursor and Claude Code hooks, .cursor/mcp.json and the recursion guard." },
  defaults: { model: { id: process.env.WF_VERIFY_MODEL ?? "composer-2.5" }, timeoutMs: 5 * 60_000, retries: 0 },
  async run(ctx) {
    const project = await ctx.agent(PROMPT, { label: "with-project", tools: ["shell", "mcp"], schema: SCHEMA, settingSources: ["project", "team", "mdm"] });
    const none = await ctx.agent(PROMPT + " ", { label: "no-settings", tools: ["shell", "mcp"], schema: SCHEMA, settingSources: [] });
    return { status: "done", project, none };
  },
});
