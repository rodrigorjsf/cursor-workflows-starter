#!/usr/bin/env node
// MCP server (stdio) that exposes the workflows to the Cursor IDE chat and to any MCP client (Claude Code, Codex).
// Asynchronous pattern: start -> jobId; wait with a short ceiling -> partial or final state. This avoids depending on
// the client's tool-call timeout, which Cursor does not document.
//
// Tools:
//   list_workflows                                  → name, description, when to use, args schema; broken files with their error
//   start_workflow {name, args, resumeRunId?, overrides?} → {jobId, runId, dashboardUrl?, dashboardWarning?, violations?}
//                                                   overrides: limits for this run, tighten-only
//                                                   dashboardUrl: the run's page on the local dashboard, started detached if it was not running
//                                                   (once, for every repo); dashboardWarning: why it could not be
//   wait_workflow  {jobId, timeoutSec?}             → state (status, phase, recent summary lines, spend, result)
//                                                   timeoutSec: a number of seconds, clamped to 1..50, 45 when absent
//   get_workflow_status {jobId}                     → state, without waiting
//   cancel_workflow {jobId}                         → cancel the job and return its state (the run stays resumable)
//
// The state is a projection of the run's event log (job-state.ts): the job record holds the job's identity and only the
// facts its process cannot put in the log (ADR-0008).
//
// Each job runs in a detached process (`spawnJob`): this server only starts it, reads its state and asks it to cancel.
// Restarting the server (or Cursor) does not affect a run in progress; the new server finds it through the job's files.
// A job whose process died, or whose heartbeat stopped, shows as "failed" with its runId; relaunch with
// start_workflow {resumeRunId}: the journal keeps finished steps from repeating.
//
// STATUS: exercised over stdio (initialize, tools/list, list_workflows) by the kit's smoke tests.

import "./console-to-stderr.js"; // stdout is the JSON-RPC channel: the SDK and workflow console goes to stderr
import "./node-check.js"; // before anything else: @cursor/sdk requires Node 22.13+
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type LimitOverrides, limitOverridesSchema, loadEffectiveConfig, parseLimitOverrides } from "./config/index.js";
import { assertKitCompatible, readKitPackage } from "./kit-version.js";
import { type DashboardStatus, ensureDashboard, runPageUrl } from "./runtime/dashboard-instance.js";
import { INSIDE_WORKFLOW_ENV } from "./runtime/engine.js";
import { installCrashHandlers, spawnJob } from "./runtime/jobs.js";
import { cancelJob, readJob, waitJob, waitSeconds } from "./runtime/job-state.js";
import { type BrokenWorkflow, discoverWorkflows } from "./runtime/registry.js";
import { plainName } from "./runtime/state.js";

installCrashHandlers();

// Step agents load the project's .cursor/mcp.json (settingSources "project") and, with the "mcp" tool allowed, could
// start this same server and launch workflows recursively. The engine marks the environment; here, inside a step, the
// server exposes no tools.
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
          description: "Lists the deterministic workflows available in this repository. A workflow file that failed to load is listed with its `file` and `error`.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "start_workflow",
          description:
            "Starts a workflow by name. The workflow runs to the end on its own (steps, models and reviews are " +
            "defined in code). Returns a jobId; then call wait_workflow until status != running. When the local " +
            "dashboard is running it also returns dashboardUrl, where the user can watch the run. Available: " +
            [...workflows.values()].map((w) => `${w.meta.name} (${w.meta.whenToUse ?? w.meta.description})`).join("; "),
          inputSchema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", enum: [...workflows.keys()] },
              args: { type: "object" },
              resumeRunId: { type: "string", description: "runId of an earlier run (one that failed, or stopped at a checkpoint and returned `next`), to resume it without repeating finished steps" },
              overrides: limitOverridesSchema(),
            },
          },
        },
        {
          name: "wait_workflow",
          description: "Waits up to timeoutSec seconds (a number, 1 to 50, default 45; outside that range it is clamped) for the job to end and returns its state. Repeat while status = running.",
          inputSchema: {
            type: "object",
            required: ["jobId"],
            properties: { jobId: { type: "string" }, timeoutSec: { type: "number", minimum: 1, maximum: 50 } },
          },
        },
        {
          name: "get_workflow_status",
          description: "Current state of a job, without waiting.",
          inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } },
        },
        {
          name: "cancel_workflow",
          description:
            "Cancels a running job: stops the active agents, reverts the step that was writing and marks the job cancelled. " +
            "A stuck process (a failed job with no heartbeat) is killed (SIGKILL) without reverting its step. " +
            "For that killed process, and for a job whose process already ended (a crash), it cancels the cloud agents the run left running, the returned note names them, and the job stays failed. " +
            "The run can be resumed later with start_workflow {resumeRunId}; a resume after a cancel that named cloud agents starts new ones in their place, at new cost. Call it only when the user asks to stop.",
          inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } },
        },
      ],
}));

/** What `start_workflow` says about the dashboard: the link to the run's page (the Board is one menu away), or why there is none. Nothing when auto-start is off. */
const dashboardFields = (d: DashboardStatus, runId: string) =>
  d.status === "running" ? { dashboardUrl: runPageUrl(d.url, runId) } : d.status === "unavailable" ? { dashboardWarning: d.reason } : {};

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (v: unknown) => ({ ...text(v), isError: true });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (nested) return fail({ error: "workflows cannot be started from inside a workflow step" });
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  switch (req.params.name) {
    case "list_workflows":
      return text([...[...workflows.values()].map((w) => ({ ...w.meta })), ...broken]);
    case "start_workflow": {
      const def = workflows.get(String(a.name));
      if (!def) return fail({ error: `unknown workflow: ${String(a.name)}` });
      const runId = typeof a.resumeRunId === "string" ? a.resumeRunId : undefined;
      // The config is read afresh here, so an unusable one is refused before a job exists, and a looser override is reported now.
      // So is a kit outside the version range the repo declares: first, because an older kit may not understand a newer config.
      let mcpOverrides: LimitOverrides;
      let violations;
      try {
        if (runId !== undefined) plainName(runId, "runId"); // it becomes a path: refused before a job or the dashboard starts
        assertKitCompatible(cwd);
        mcpOverrides = parseLimitOverrides(a.overrides);
        violations = loadEffectiveConfig(def, { cwd, mcpOverrides }).violations;
      } catch (err) {
        if (err instanceof Error) return fail({ error: err.message });
        throw err;
      }
      // The dashboard starts while the job's process does: the link is live by the time the chat has it.
      const dashboard = ensureDashboard();
      const { job } = spawnJob({ cwd, workflow: def.meta.name, args: a.args ?? {}, resumeRunId: runId, overrides: mcpOverrides });
      return text({ jobId: job.jobId, runId: job.runId, next: "call wait_workflow with this jobId", ...dashboardFields(await dashboard, job.runId), ...(violations.length ? { violations } : {}) });
    }
    case "wait_workflow": {
      let secs: number;
      try {
        secs = waitSeconds(a.timeoutSec); // checked first: a bad value is an error even for a job that is not there
      } catch (err) {
        if (err instanceof Error) return fail({ error: err.message });
        throw err;
      }
      return text((await waitJob(cwd, String(a.jobId), secs * 1000)) ?? { error: "job not found" });
    }
    case "get_workflow_status":
      return text(readJob(cwd, String(a.jobId)) ?? { error: "job not found" });
    case "cancel_workflow":
      return text((await cancelJob(cwd, String(a.jobId), 20_000)) ?? { error: "job not found" });
    default:
      return fail({ error: `unknown tool: ${req.params.name}` });
  }
});

await server.connect(new StdioServerTransport());
