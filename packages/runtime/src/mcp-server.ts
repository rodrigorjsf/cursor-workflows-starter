#!/usr/bin/env node
// MCP server (stdio) que expõe os workflows ao chat do Cursor IDE e a qualquer cliente MCP (Claude Code,
// Codex). Padrão assíncrono: start → jobId; wait com teto curto → estado parcial ou final. Isso evita
// depender do timeout de chamada de tool do cliente, que o Cursor não documenta.
//
// Tools:
//   list_workflows                                  → nome, descrição, quando usar, schema dos args
//   start_workflow {name, args, resumeRunId?, overrides?} → {jobId, runId, violations?}
//                                                   overrides: limits for this run, tighten-only
//   wait_workflow  {jobId, timeoutSec}              → estado (status, fase, últimas linhas de resumo, gasto, resultado)
//   get_workflow_status {jobId}                     → estado sem esperar
//   cancel_workflow {jobId}                         → cancel the job and return its state (the run stays resumable)
//
// The state is a projection of the run's event log (jobs.ts): the job record holds identity only.
//
// Each job runs in a detached process (`spawnJob`): this server only starts it, reads its state and asks it to cancel.
// Restarting the server (or Cursor) does not affect a run in progress; the new server finds it through the job's files.
// A job whose process died, or whose heartbeat stopped, shows as "failed" with its runId; relaunch with
// start_workflow {resumeRunId}: the journal keeps finished steps from repeating.
//
// STATUS: exercitado por stdio (initialize, tools/list, list_workflows) nos testes de fumaça do kit.

import "./console-to-stderr.js"; // stdout é o canal JSON-RPC: o console do SDK e dos workflows vai para o stderr
import "./node-check.js"; // antes de tudo: o @cursor/sdk exige Node 22.13+
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type LimitOverrides, loadEffectiveConfig, parseLimitOverrides } from "./config/index.js";
import { assertKitCompatible, readKitPackage } from "./kit-version.js";
import { INSIDE_WORKFLOW_ENV } from "./runtime/engine.js";
import { cancelJob, installCrashHandlers, readJob, spawnJob, waitJob } from "./runtime/jobs.js";
import { type BrokenWorkflow, discoverWorkflows } from "./runtime/registry.js";

installCrashHandlers();

// Os agentes das etapas carregam o .cursor/mcp.json do projeto (settingSources "project") e, com a
// tool "mcp" liberada, poderiam iniciar este mesmo servidor e disparar workflows recursivamente.
// O engine marca o ambiente; aqui, dentro de uma etapa, o servidor não expõe nenhuma tool.
const nested = process.env[INSIDE_WORKFLOW_ENV] === "1";

const cwd = process.env.WF_CWD ?? process.cwd();
// A broken workflow file must not take the server down: it is listed in list_workflows with its error instead.
const { workflows, broken } = nested
  ? { workflows: new Map(), broken: [] as BrokenWorkflow[] }
  : await discoverWorkflows(cwd);

const { version } = readKitPackage();
const server = new Server({ name: "cursor-workflows", version }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: nested
    ? []
    : [
        {
          name: "list_workflows",
          description: "Lista os workflows determinísticos disponíveis neste repositório.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "start_workflow",
          description:
            "Inicia um workflow pelo nome. O workflow roda até o fim por conta própria (etapas, modelos e revisões " +
            "definidos em código). Retorna um jobId; depois chame wait_workflow até status != running. Disponíveis: " +
            [...workflows.values()].map((w) => `${w.meta.name} (${w.meta.whenToUse ?? w.meta.description})`).join("; "),
          inputSchema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", enum: [...workflows.keys()] },
              args: { type: "object" },
              resumeRunId: { type: "string", description: "runId de um run anterior (que falhou, ou que parou num checkpoint e devolveu `next`), para retomar sem repetir etapas concluídas" },
              overrides: {
                type: "object",
                description:
                  "Limites mais apertados só para este run (por exemplo um teto de tokens menor para um experimento). Só aperta: um valor mais frouxo que o da configuração, ou os tetos globais, não tem efeito e volta em `violations`.",
                additionalProperties: false,
                properties: {
                  maxTokens: { type: "integer", minimum: 0, description: "Teto de tokens do run." },
                  maxTokensPerStep: { type: "integer", minimum: 0, description: "Teto de tokens de cada etapa." },
                  maxCents: { type: "number", minimum: 0, description: "Teto de custo do run, em centavos." },
                  concurrency: { type: "integer", minimum: 1, description: "Agentes simultâneos." },
                },
              },
            },
          },
        },
        {
          name: "wait_workflow",
          description: "Espera até timeoutSec (máx. 50) pelo fim do job e devolve o estado. Repita enquanto status = running.",
          inputSchema: {
            type: "object",
            required: ["jobId"],
            properties: { jobId: { type: "string" }, timeoutSec: { type: "number", maximum: 50 } },
          },
        },
        {
          name: "get_workflow_status",
          description: "Estado atual de um job, sem esperar.",
          inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } },
        },
        {
          name: "cancel_workflow",
          description:
            "Cancela um job em andamento: para os agentes ativos, desfaz a etapa que estava escrevendo e marca o job como cancelled. " +
            "Um processo travado (job failed com 'sem sinal de vida') é encerrado à força. " +
            "O run pode ser retomado depois com start_workflow {resumeRunId}. Só chame quando o usuário pedir para parar.",
          inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } },
        },
      ],
}));

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (v: unknown) => ({ ...text(v), isError: true });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (nested) return fail({ error: "workflows não podem ser iniciados de dentro de uma etapa de workflow" });
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  switch (req.params.name) {
    case "list_workflows":
      return text([...[...workflows.values()].map((w) => ({ ...w.meta })), ...broken]);
    case "start_workflow": {
      const def = workflows.get(String(a.name));
      if (!def) return fail({ error: `workflow desconhecido: ${String(a.name)}` });
      const runId = typeof a.resumeRunId === "string" ? a.resumeRunId : undefined;
      // The config is read afresh here, so an unusable one is refused before a job exists, and a looser override is reported now.
      // So is a kit outside the version range the repo declares: first, because an older kit may not understand a newer config.
      let mcpOverrides: LimitOverrides;
      let violations;
      try {
        assertKitCompatible(cwd);
        mcpOverrides = parseLimitOverrides(a.overrides);
        violations = loadEffectiveConfig(def, { cwd, mcpOverrides }).violations;
      } catch (err) {
        if (err instanceof Error) return fail({ error: err.message });
        throw err;
      }
      const { job } = spawnJob({ cwd, workflow: def.meta.name, args: a.args ?? {}, resumeRunId: runId, overrides: mcpOverrides });
      return text({ jobId: job.jobId, runId: job.runId, next: "chame wait_workflow com este jobId", ...(violations.length ? { violations } : {}) });
    }
    case "wait_workflow": {
      const secs = Math.min(Number(a.timeoutSec ?? 45), 50);
      return text((await waitJob(cwd, String(a.jobId), secs * 1000)) ?? { error: "job não encontrado" });
    }
    case "get_workflow_status":
      return text(readJob(cwd, String(a.jobId)) ?? { error: "job não encontrado" });
    case "cancel_workflow":
      return text((await cancelJob(cwd, String(a.jobId), 20_000)) ?? { error: "job não encontrado" });
    default:
      return fail({ error: `tool desconhecida: ${req.params.name}` });
  }
});

await server.connect(new StdioServerTransport());
