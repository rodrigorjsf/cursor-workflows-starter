#!/usr/bin/env node
// MCP server (stdio) that exposes the workflows to the Cursor IDE chat and to any MCP client (Claude Code, Codex).
// Asynchronous pattern: start -> jobId; wait with a short ceiling -> partial or final state. This avoids depending on
// the client's tool-call timeout, which Cursor does not document.
//
// Tools:
//   list_workflows                                  → name, description, when to use, args schema; broken files with their error
//   start_workflow {name, args, resumeRunId?, overrides?} → {jobId, runId, dashboardUrl?, dashboardWarning?, violations?}
//                                                   overrides: limits for this run, tighten-only
//                                                   refused (isError, no job) past caps.maxRunningJobs running jobs, and for a job that already runs (same workflow, same args)
//                                                   dashboardUrl: the run's page on the local dashboard, started detached if it was not running
//                                                   (once, for every repo); dashboardWarning: why it could not be
//   wait_workflow  {jobId, timeoutSec?}             → state (status, phase, recent summary lines, spend, result)
//                                                   timeoutSec: a number of seconds (a numeric string too), clamped to 1..50, 45 when absent or null
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
// Each tool is one `McpServer.registerTool` call, with a strict zod object as its input schema (`z.strictObject`: zod 4's
// `z.object` would strip an unknown key, not refuse it). The SDK checks a call's arguments against it before the handler
// runs. Failures come back flagged `isError: true`, in two shapes:
//   - a failure of a handler (unknown workflow, job not found, args that do not fit the workflow's `argsSchema`, a refused
//     config, an unknown or malformed override, a bad `timeoutSec`) is a JSON text `{ "error": "..." }`;
//   - a failure the SDK finds first is its own plain text, which is not JSON: a client that parses every reply must look
//     at `isError` first. It is a call that breaks the input schema (a missing, mistyped or unlisted argument):
//     `MCP error -32602: Input validation error: Invalid arguments for tool <name>: ...`, which names the property; and a
//     call to a tool that is not registered: `MCP error -32602: Tool <name> not found` (the low-level `Server` answered
//     `{ "error": "unknown tool: <name>" }`).
// What the schemas leave to a handler: the workflow's `args` (an object here; the workflow's `argsSchema` is checked in
// `start_workflow`, before the dashboard starts and a job exists, so the model hears it at once and not on a later
// `wait_workflow`), the keys and values of `overrides` (`parseLimitOverrides` names an unknown override) and `timeoutSec`
// (`waitSeconds`: a numeric string counts as its number and `null` as absent, a number is clamped to 1..50). A throw in a
// handler is an `isError` reply too, where the low-level `Server` answered with a JSON-RPC error.
//
// STATUS: exercised over stdio (initialize, tools/list, list_workflows) by the kit's smoke tests; test/mcp-tools.process.test.ts
// pins the tools, their schemas, the error shapes and the guard of a workflow step.

import "./console-to-stderr.js"; // stdout is the JSON-RPC channel: the SDK and workflow console goes to stderr
import "./node-check.js"; // before anything else: @cursor/sdk requires Node 22.13+
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type LimitOverrides, limitOverridesSchema, loadEffectiveConfig, parseLimitOverrides } from "./config/index.js";
import { assertKitCompatible, readKitPackage } from "./kit-version.js";
import { argsError } from "./runtime/args-schema.js";
import { dashboardFields, ensureDashboard } from "./runtime/dashboard-instance.js";
import { insideWorkflow } from "./runtime/inside-workflow.js";
import { installCrashHandlers, spawnJob } from "./runtime/jobs.js";
import { cancelJob, readJob, waitJob, waitSeconds } from "./runtime/job-state.js";
import { type BrokenWorkflow, discoverWorkflows } from "./runtime/registry.js";
import { plainName } from "./runtime/state.js";

installCrashHandlers();

// Step agents load the project's .cursor/mcp.json (settingSources "project") and, with the "mcp" tool allowed, could
// start this same server and launch workflows recursively. The engine marks the environment; here, inside a step, the
// server exposes no tools.
const nested = insideWorkflow();

const cwd = process.env.WF_CWD ?? process.cwd();
// A broken workflow file must not take the server down: it is listed in list_workflows with its error instead.
const { workflows, broken } = nested
  ? { workflows: new Map(), broken: [] as BrokenWorkflow[] }
  : await discoverWorkflows(cwd);

const { version } = readKitPackage();
// `tools: {}` makes the SDK answer tools/list from the start: with no tool registered (inside a step) it lists none.
const server = new McpServer({ name: "cursor-workflows", version }, { capabilities: { tools: {} } });

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (v: unknown) => ({ ...text(v), isError: true });
/** A job's state, or the `job not found` error (flagged, like every failure) when there is no such job. */
const found = (state: unknown) => (state === undefined ? fail({ error: "job not found" }) : text(state));

/**
 * `wait_workflow`'s `timeoutSec`: the one argument whose value the handler checks itself (`waitSeconds`). The model is told a
 * number from 1 to 50 (`tools/list`); the handler takes what it has always taken (a numeric string counts as its number, `null`
 * as absent, a number outside the range is clamped) and says why when it refuses, so the schema accepts any value.
 */
const timeoutSec = z.unknown().meta({ type: "number", minimum: 1, maximum: 50 }).optional();

if (nested) {
  // The SDK would answer a call to a tool it does not have with its own "not found"; inside a step the reason is the point.
  server.server.setRequestHandler(CallToolRequestSchema, async () => fail({ error: "workflows cannot be started from inside a workflow step" }));
} else {
  server.registerTool(
    "list_workflows",
    {
      description: "Lists the deterministic workflows available in this repository. A workflow file that failed to load is listed with its `file` and `error`.",
      inputSchema: z.strictObject({}),
    },
    async () => text([...[...workflows.values()].map((w) => ({ ...w.meta })), ...broken]),
  );

  server.registerTool(
    "start_workflow",
    {
      description:
        "Starts a workflow by name. The workflow runs to the end on its own (steps, models and reviews are " +
        "defined in code). Returns a jobId; then call wait_workflow until status != running. When the local " +
        "dashboard is running it also returns dashboardUrl, where the user can watch the run. It is refused (isError, nothing started) when " +
        "the repository already runs as many jobs as caps.maxRunningJobs allows (3 by default), already runs this workflow with the same args: " +
        "wait for that job instead of starting another, or the user directory ~/.cursor-workflows cannot be written (an agent sandbox is the likely cause: " +
        "the server must run with full permissions). Available: " +
        [...workflows.values()].map((w) => `${w.meta.name} (${w.meta.whenToUse ?? w.meta.description})`).join("; "),
      inputSchema: z.strictObject({
        // The handler answers a name it does not know with `unknown workflow`; the list is for the model.
        name: z.string().meta({ enum: [...workflows.keys()] }),
        // The workflow's `argsSchema` is checked in the handler, once the workflow is known.
        args: z.record(z.string(), z.unknown()).optional(),
        resumeRunId: z.string().meta({ description: "runId of an earlier run (one that failed, or stopped at a checkpoint and returned `next`), to resume it without repeating finished steps" }).optional(),
        // The keys and values are checked by `parseLimitOverrides`, which names an unknown override; `tools/list` lists the limits.
        overrides: z.record(z.string(), z.unknown()).meta(limitOverridesSchema()).optional(),
      }),
    },
    async (a) => {
      const def = workflows.get(a.name);
      if (!def) return fail({ error: `unknown workflow: ${a.name}` });
      // Checked here, as the job's process would, so the model hears it now and not on a later wait_workflow: before the dashboard starts and a job exists.
      const badArgs = argsError(def.meta.argsSchema, a.args ?? {});
      if (badArgs) return fail({ error: badArgs });
      // The config is read afresh here, so an unusable one is refused before a job exists, and a looser override is reported now.
      // So is a kit outside the version range the repo declares, checked before the config because an older kit may not understand a newer config.
      let mcpOverrides: LimitOverrides;
      let violations;
      let job;
      try {
        if (a.resumeRunId !== undefined) plainName(a.resumeRunId, "runId"); // it becomes a path: refused before a job or the dashboard starts
        assertKitCompatible(cwd);
        mcpOverrides = parseLimitOverrides(a.overrides);
        const { config, violations: loose } = loadEffectiveConfig(def, { cwd, mcpOverrides });
        violations = loose;
        // A model calls this tool and every job spends money: past the cap (or for a job that already runs) it is refused, before the dashboard starts.
        ({ job } = spawnJob({ cwd, workflow: def.meta.name, args: a.args ?? {}, maxRunningJobs: config.caps.maxRunningJobs, resumeRunId: a.resumeRunId, overrides: mcpOverrides }));
      } catch (err) {
        if (err instanceof Error) return fail({ error: err.message });
        throw err;
      }
      // The dashboard starts as the job's process does: the link is live by the time the chat has it.
      const dashboard = ensureDashboard();
      return text({ jobId: job.jobId, runId: job.runId, next: "call wait_workflow with this jobId", ...dashboardFields(await dashboard, job.runId), ...(violations.length ? { violations } : {}) });
    },
  );

  server.registerTool(
    "wait_workflow",
    {
      description: "Waits up to timeoutSec seconds (a number, 1 to 50, default 45 when absent or null; outside that range it is clamped; a numeric string counts as its number) for the job to end and returns its state. Repeat while status = running.",
      inputSchema: z.strictObject({ jobId: z.string(), timeoutSec }),
    },
    async (a) => {
      let secs: number;
      try {
        secs = waitSeconds(a.timeoutSec); // checked first: a bad value is an error even for a job that is not there
      } catch (err) {
        if (err instanceof Error) return fail({ error: err.message });
        throw err;
      }
      return found(await waitJob(cwd, a.jobId, secs * 1000));
    },
  );

  server.registerTool(
    "get_workflow_status",
    { description: "Current state of a job, without waiting.", inputSchema: z.strictObject({ jobId: z.string() }) },
    async (a) => found(readJob(cwd, a.jobId)),
  );

  server.registerTool(
    "cancel_workflow",
    {
      description:
        "Cancels a running job: stops the active agents, reverts the step that was writing and marks the job cancelled. " +
        "A stuck process (a failed job with no heartbeat) is killed (SIGKILL) without reverting its step, and the commands it started through ctx.exec are killed with it. " +
        "For that killed process, and for a job whose process already ended (a crash), it cancels the cloud agents the run left running, the returned note names them, and the job stays failed. " +
        "The run can be resumed later with start_workflow {resumeRunId}; a resume after a cancel that named cloud agents starts new ones in their place, at new cost. Call it only when the user asks to stop.",
      inputSchema: z.strictObject({ jobId: z.string() }),
    },
    async (a) => found(await cancelJob(cwd, a.jobId, 20_000)),
  );
}

await server.connect(new StdioServerTransport());
