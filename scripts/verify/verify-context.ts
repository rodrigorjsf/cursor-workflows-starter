// Verificação real: o que settingSources carrega em runs locais e a guarda contra recursão
// (ver docs/research/verificacoes-locais.md §7). Rode sobre o repositório criado por setup-probe-repo.sh.
import { defineWorkflow } from "../../src/runtime/workflow.js";

const SCHEMA = {
  type: "object",
  required: ["marker", "mcpTools", "echoOutput", "blockedCommand", "insideEnv"],
  properties: {
    marker: { type: "string", description: "a palavra de verificação das instruções do projeto, ou NENHUMA" },
    mcpTools: { type: "array", items: { type: "string" }, description: "nomes das ferramentas MCP disponíveis para você" },
    echoOutput: { type: "string" },
    blockedCommand: { type: "string", description: "executado | bloqueado, com a mensagem recebida" },
    insideEnv: { type: "string", description: "a saída exata do último comando" },
  },
};
const PROMPT =
  "Não leia nenhum arquivo. 1) Qual é a palavra de verificação definida nas instruções do projeto que você recebeu? Se não recebeu nenhuma, responda NENHUMA. " +
  "2) Liste os nomes de todas as ferramentas MCP disponíveis para você. 3) Rode no shell `echo hook-ok` e informe a saída. " +
  "4) Rode no shell `echo proibido-pelo-claude` e diga se foi executado ou bloqueado, com a mensagem que recebeu. " +
  "5) Rode no shell `echo inside=$WF_INSIDE_WORKFLOW` e informe a saída exata.";

export default defineWorkflow({
  meta: { name: "verify-context", description: "Verificação: AGENTS.md, hooks do Cursor e do Claude Code, .cursor/mcp.json e guarda contra recursão." },
  defaults: { model: { id: process.env.WF_VERIFY_MODEL ?? "composer-2.5" }, timeoutMs: 5 * 60_000, retries: 0 },
  async run(ctx) {
    const project = await ctx.agent(PROMPT, { label: "com-project", tools: ["shell", "mcp"], schema: SCHEMA, settingSources: ["project", "team", "mdm"] });
    const none = await ctx.agent(PROMPT + " ", { label: "sem-settings", tools: ["shell", "mcp"], schema: SCHEMA, settingSources: [] });
    return { status: "done", project, none };
  },
});
