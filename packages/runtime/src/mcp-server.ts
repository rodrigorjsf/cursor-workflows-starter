#!/usr/bin/env node
// MCP server (stdio) que expõe os workflows ao chat do Cursor IDE e a qualquer cliente MCP (Claude Code,
// Codex). Padrão assíncrono: start → jobId; wait com teto curto → estado parcial ou final. Isso evita
// depender do timeout de chamada de tool do cliente, que o Cursor não documenta.
//
// Tools:
//   list_workflows                                  → nome, descrição, quando usar, schema dos args
//   start_workflow {name, args, resumeRunId?, overrides?} → {jobId, runId, violations?}
//                                                   overrides: limites só mais apertados para este run
//   wait_workflow  {jobId, timeoutSec}              → estado (status, fase, últimos eventos, resultado)
//   get_workflow_status {jobId}                     → estado sem esperar
//
// Os jobs rodam dentro deste processo. Se o cliente reiniciar o servidor, o job em andamento morre e
// passa a aparecer como "failed" com o runId; relance com start_workflow {resumeRunId} — o journal
// evita repetir etapas concluídas. Para runs longos e frágeis, prefira `wf start` (processo destacado).
//
// STATUS: exercitado por stdio (initialize, tools/list, list_workflows) nos testes de fumaça do kit.

import "./console-to-stderr.js"; // stdout é o canal JSON-RPC: o console do SDK e dos workflows vai para o stderr
import "./node-check.js"; // antes de tudo: o @cursor/sdk exige Node 22.13+
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type LimitOverrides, loadEffectiveConfig } from "./config/index.js";
import { INSIDE_WORKFLOW_ENV } from "./runtime/engine.js";
import { installCrashHandlers, readJob, startJob, waitJob } from "./runtime/jobs.js";
import { loadWorkflows } from "./runtime/registry.js";

installCrashHandlers();

// Os agentes das etapas carregam o .cursor/mcp.json do projeto (settingSources "project") e, com a
// tool "mcp" liberada, poderiam iniciar este mesmo servidor e disparar workflows recursivamente.
// O engine marca o ambiente; aqui, dentro de uma etapa, o servidor não expõe nenhuma tool.
const nested = process.env[INSIDE_WORKFLOW_ENV] === "1";

const cwd = process.env.WF_CWD ?? process.cwd();
const workflows = nested ? new Map() : await loadWorkflows(cwd);

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
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
      ],
}));

const OVERRIDE_KEYS = ["maxTokens", "maxTokensPerStep", "maxCents", "concurrency"] as const;

/** The `overrides` argument as limit overrides. A non-number is an error; `null` is accepted and counts as a loosening attempt. */
function parseOverrides(raw: unknown): LimitOverrides {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("overrides precisa ser um objeto");
  const tighten: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) throw new Error(`override desconhecido: ${key} (use ${OVERRIDE_KEYS.join(", ")})`);
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`override ${key} precisa ser um número maior ou igual a 0`);
    tighten[key] = value as number | null;
  }
  return tighten;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (v: unknown) => ({ ...text(v), isError: true });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (nested) return fail({ error: "workflows não podem ser iniciados de dentro de uma etapa de workflow" });
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  switch (req.params.name) {
    case "list_workflows":
      return text([...workflows.values()].map((w) => ({ ...w.meta })));
    case "start_workflow": {
      const def = workflows.get(String(a.name));
      if (!def) return fail({ error: `workflow desconhecido: ${String(a.name)}` });
      const runId = typeof a.resumeRunId === "string" ? a.resumeRunId : undefined;
      // The config is read afresh here, so an unusable one is refused before a job exists, and a looser override is reported now.
      let tighten: LimitOverrides;
      let violations;
      try {
        tighten = parseOverrides(a.overrides);
        violations = loadEffectiveConfig(def, { cwd, tighten }).violations;
      } catch (err) {
        if (err instanceof Error) return fail({ error: err.message });
        throw err;
      }
      const { job } = startJob(def, a.args ?? {}, { cwd, tighten, runId });
      return text({ jobId: job.jobId, runId: job.runId, next: "chame wait_workflow com este jobId", ...(violations.length ? { violations } : {}) });
    }
    case "wait_workflow": {
      const secs = Math.min(Number(a.timeoutSec ?? 45), 50);
      return text((await waitJob(cwd, String(a.jobId), secs * 1000)) ?? { error: "job não encontrado" });
    }
    case "get_workflow_status":
      return text(readJob(cwd, String(a.jobId)) ?? { error: "job não encontrado" });
    default:
      return fail({ error: `tool desconhecida: ${req.params.name}` });
  }
});

await server.connect(new StdioServerTransport());
