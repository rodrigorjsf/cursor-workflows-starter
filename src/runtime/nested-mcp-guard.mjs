// Servidor MCP sem tools, usado pelo engine para substituir o servidor `workflows` do projeto dentro das etapas.
//
// Por quê: com settingSources "project", o Cursor SDK sobe os servidores do .cursor/mcp.json para o agente da
// etapa, mas sem repassar o ambiente do processo (medido em 2026-11-11: WF_INSIDE_WORKFLOW chegava vazio e a etapa
// via start_workflow). Um servidor inline com o mesmo nome vence o do arquivo (ordem: send > create > plugins >
// .cursor/mcp.json > ~/.cursor/mcp.json), e este não expõe nada.
//
// JavaScript puro (sem tsx) para subir rápido em cada etapa.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "cursor-workflows-nested-guard", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
await server.connect(new StdioServerTransport());
