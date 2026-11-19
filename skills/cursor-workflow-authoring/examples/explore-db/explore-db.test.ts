import assert from "node:assert/strict";
import "../../../../packages/runtime/test/isolate-home.js";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { calls, costConfig, script, stats } from "../../../../packages/runtime/test/fake-sdk.js";
import { runWorkflow } from "../../../../packages/runtime/src/runtime/engine.js";
import type { ExecStartEvent, StepStartEvent, WorkflowEvent } from "../../../../packages/runtime/src/runtime/events.js";
import { projectLatestExecution } from "../../../../packages/runtime/src/runtime/projection.js";
import { eventLogPath, readEventLog } from "../../../../packages/runtime/src/runtime/run-store.js";
import exploreDb from "./explore-db.js";

const SCRIPTED_STEPS = 30;
const SCRIPTED_FAILURE = Symbol("scripted failure");

type Answer = Record<string, unknown> | typeof SCRIPTED_FAILURE;

let cwd: string;
let handlers: Map<string, (prompt: string) => Answer>;
let prompts: Array<{ label: string; prompt: string }>;

const labelOf = (options: { name: string }) => options.name.replace(/^explore-db:/, "");

const answerByLabel = (options: { name: string; local: { customTools: { submit_result: { execute(value: unknown, context: object): unknown } } } }, prompt: string) => {
  const label = labelOf(options);
  prompts.push({ label, prompt });
  const answer = handlers.get(label)?.(prompt);
  if (answer === undefined) throw new Error(`no scripted answer for the step ${label}`);
  if (answer === SCRIPTED_FAILURE) return { status: "error", error: { message: "scripted failure" } };
  options.local.customTools.submit_result.execute(answer, {});
  return {};
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "wf-explore-db-"));
  handlers = new Map();
  prompts = [];
  for (let step = 0; step < SCRIPTED_STEPS; step++) script.push(answerByLabel);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

const eventsOf = (runId: string): WorkflowEvent[] => readEventLog(eventLogPath(cwd, runId)).events;
const mcpCalls = (events: WorkflowEvent[]) => events.filter((event): event is ExecStartEvent => event.type === "exec-start" && event.command === "mcp");
const agentSteps = (events: WorkflowEvent[]) => events.filter((event): event is StepStartEvent => event.type === "step-start");

const INDEX_FINDINGS = {
  findings: [
    { table: "Orders", category: "unindexed-foreign-key", severity: "high", problem: "customer_id references customers and has no index", fix: "CREATE INDEX idx_orders_customer ON Orders (customer_id)" },
    { table: "order_items", category: "unindexed-foreign-key", severity: "high", problem: "order_id references Orders and has no index", fix: "CREATE INDEX idx_order_items_order ON order_items (order_id)" },
  ],
};
const NAMING_FINDINGS = {
  findings: [{ table: "Orders", category: "inconsistent-case", severity: "medium", problem: "Orders and OrderID are capitalized, the other tables are snake_case", fix: "rename to orders and order_id" }],
};
const NORMALIZATION_FINDINGS = {
  findings: [
    { table: "Orders", category: "derived-column", severity: "low", problem: "customer_city repeats customers.city", fix: "drop customer_city and join customers" },
    { table: "order_items", category: "repeated-value", severity: "medium", problem: "product_name repeats for every row of the same sku", fix: "move sku and product_name to a products table" },
  ],
};

const scriptReviewers = () => {
  handlers.set("review:indexes", () => INDEX_FINDINGS);
  handlers.set("review:naming", () => NAMING_FINDINGS);
  handlers.set("review:normalization", () => NORMALIZATION_FINDINGS);
};

test("review collects the schema with no agent, runs one agent per axis and returns the findings routed by severity", async () => {
  scriptReviewers();
  const run = await runWorkflow(exploreDb, { mode: "review" }, { cwd, metricsDb: false });

  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(run.result, {
    status: "done",
    mode: "review",
    report: {
      tables: [
        { table: "Orders", rows: 3 },
        { table: "customers", rows: 2 },
        { table: "order_items", rows: 3 },
      ],
      mustFix: INDEX_FINDINGS.findings.map((finding) => ({ axis: "indexes", ...finding })),
      shouldFix: [
        { axis: "naming", ...NAMING_FINDINGS.findings[0] },
        { axis: "normalization", ...NORMALIZATION_FINDINGS.findings[1] },
      ],
      notes: [{ axis: "normalization", ...NORMALIZATION_FINDINGS.findings[0] }],
    },
  });

  assert.deepEqual(calls.map(labelOf).sort(), ["review:indexes", "review:naming", "review:normalization"]);
  const events = eventsOf(run.runId);
  const schemaCalls = mcpCalls(events).map((call) => call.label);
  assert.deepEqual(schemaCalls, ["list tables", "describe Orders", "count Orders", "describe customers", "count customers", "describe order_items", "count order_items"]);
  const lastSchemaCall = events.findLastIndex((event) => event.type === "exec-end" && event.command === "mcp");
  const firstAgentStep = events.findIndex((event) => event.type === "step-start");
  assert.ok(lastSchemaCall < firstAgentStep, "every schema call ended before the first agent step started");
  for (const { prompt } of prompts) assert.match(prompt, /"name": "customer_city"/, "the collected schema reaches each reviewer");
});

test("a reviewer that fails ends the run as review-failed, never as a review with no findings", async () => {
  scriptReviewers();
  handlers.set("review:naming", () => SCRIPTED_FAILURE);
  const run = await runWorkflow(exploreDb, { mode: "review" }, { cwd, metricsDb: false });

  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(run.result, { status: "review-failed", failedAxes: ["naming"] });
});

test("a mode that is not review or interview is refused before the run starts", async () => {
  const run = await runWorkflow(exploreDb, { mode: "audit" } as never, { cwd, metricsDb: false });

  assert.equal(run.status, "failed");
  assert.equal(run.refused, true);
  assert.match(run.error ?? "", /^invalid args: .*\/mode must be equal to one of the allowed values/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(eventLogPath(cwd, run.runId)), false, "no run was written");
});

test("a run with no mode is refused before the run starts", async () => {
  const run = await runWorkflow(exploreDb, {} as never, { cwd, metricsDb: false });

  assert.equal(run.refused, true);
  assert.match(run.error ?? "", /must have required property 'mode'/);
});

const QUESTIONNAIRE = {
  questions: [
    { id: "focus", text: "Which axis matters most?", options: ["indexes", "naming", "normalization"] },
    { id: "depth", text: "How deep should the review go?", options: ["quick", "thorough"] },
  ],
};
const REPORT = {
  summary: "Index the two foreign keys first.",
  recommendations: [
    { table: "Orders", advice: "CREATE INDEX idx_orders_customer ON Orders (customer_id)" },
    { table: "order_items", advice: "CREATE INDEX idx_order_items_order ON order_items (order_id)" },
  ],
};
const ANSWERS = { focus: "indexes", depth: "quick" };

const scriptInterview = () => {
  handlers.set("questionnaire", () => QUESTIONNAIRE);
  handlers.set("report", () => REPORT);
};

const interviewArgs = (answers?: Record<string, string>) => ({ mode: "interview" as const, ...(answers && { answers }) });

test("interview proposes a finite questionnaire and returns a checkpoint with the command that resumes the run", async () => {
  scriptInterview();
  const run = await runWorkflow(exploreDb, interviewArgs(), { cwd, metricsDb: false });

  assert.equal(run.status, "finished", run.error);
  assert.deepEqual(run.result, {
    status: "questions-proposed",
    mode: "interview",
    runId: run.runId,
    questions: QUESTIONNAIRE.questions,
    next: `npm run wf -- run explore-db --args '{"mode":"interview","answers":{"focus":"indexes | naming | normalization","depth":"quick | thorough"}}' --resume ${run.runId}`,
  });
  assert.deepEqual(calls.map(labelOf), ["questionnaire"], "no review agent ran, and the schema collection made no agent call");
  assert.ok(mcpCalls(eventsOf(run.runId)).length > 0, "the schema was collected through ctx.mcp");
});

test("a run that stops at the checkpoint is classed as waiting for the person, not as a failure", async () => {
  scriptInterview();
  const run = await runWorkflow(exploreDb, interviewArgs(), { cwd, metricsDb: false });

  assert.equal(projectLatestExecution(eventsOf(run.runId))?.outcome, "pending");
});

test("a resume with the answers continues the run: the questionnaire comes back from the journal and the report is shaped by the answers", async () => {
  scriptInterview();
  const first = await runWorkflow(exploreDb, interviewArgs(), { cwd, metricsDb: false });
  const resumed = await runWorkflow(exploreDb, interviewArgs(ANSWERS), { cwd, runId: first.runId, metricsDb: false });

  assert.equal(resumed.runId, first.runId);
  assert.equal(resumed.status, "finished", resumed.error);
  assert.deepEqual(resumed.result, { status: "done", mode: "interview", answers: ANSWERS, report: REPORT });
  assert.deepEqual(calls.map(labelOf), ["questionnaire", "report"], "the questionnaire agent ran once, in the first execution");
  const questionnaireSteps = agentSteps(eventsOf(first.runId)).filter((step) => step.label === "questionnaire");
  assert.deepEqual(questionnaireSteps.map((step) => step.cached), [false, "journal"]);
  const reportPrompt = prompts.find((entry) => entry.label === "report")!.prompt;
  assert.match(reportPrompt, /Which axis matters most\?: indexes\nHow deep should the review go\?: quick/);
});

test("answers that do not fit the questionnaire ask the questions again with the problems named, and no report is written", async () => {
  scriptInterview();
  const first = await runWorkflow(exploreDb, interviewArgs(), { cwd, metricsDb: false });
  const resumed = await runWorkflow(exploreDb, interviewArgs({ focus: "pricing", colour: "blue" }), { cwd, runId: first.runId, metricsDb: false });

  assert.equal(resumed.status, "finished", resumed.error);
  assert.deepEqual(resumed.result, {
    status: "questions-proposed",
    mode: "interview",
    problems: ['focus: "pricing" is not one of indexes, naming, normalization', "depth: no answer", "colour: no such question"],
    runId: first.runId,
    questions: QUESTIONNAIRE.questions,
    next: (first.result as { next: string }).next,
  });
  assert.deepEqual(calls.map(labelOf), ["questionnaire"]);
});

test("answers are refused before the run starts unless the mode is interview, and each answer is a string", async () => {
  const withReview = await runWorkflow(exploreDb, { mode: "review", answers: ANSWERS } as never, { cwd, metricsDb: false });
  const withNumber = await runWorkflow(exploreDb, { mode: "interview", answers: { focus: 1 } } as never, { cwd, metricsDb: false });

  for (const refused of [withReview, withNumber]) {
    assert.equal(refused.refused, true);
    assert.match(refused.error ?? "", /^invalid args: /);
  }
  assert.equal(calls.length, 0);
});

const copyOfWorkflow = async (serverSource?: string) => {
  const folder = join(cwd, "copy");
  mkdirSync(folder);
  symlinkSync(join(import.meta.dirname, "..", "..", "..", "..", "node_modules"), join(folder, "node_modules"));
  copyFileSync(join(import.meta.dirname, "explore-db.ts"), join(folder, "explore-db.mts"));
  if (serverSource) writeFileSync(join(folder, "fake-db-server.mjs"), serverSource);
  return (await import(pathToFileURL(join(folder, "explore-db.mts")).href)).default;
};

test("copied with its fake server into a repo's .agents/workflows, the example is listed and the server stays off the stdio of the process that lists it", () => {
  const workflows = join(cwd, ".agents", "workflows");
  mkdirSync(workflows, { recursive: true });
  symlinkSync(join(import.meta.dirname, "..", "..", "..", "..", "node_modules"), join(cwd, "node_modules"));
  for (const file of ["explore-db.ts", "fake-db-server.mjs"]) copyFileSync(join(import.meta.dirname, file), join(workflows, file));
  const registry = pathToFileURL(join(import.meta.dirname, "..", "..", "..", "..", "packages", "runtime", "src", "runtime", "registry.ts")).href;
  const lister = `const { discoverWorkflows } = await import(${JSON.stringify(registry)});
    const { workflows, broken } = await discoverWorkflows(${JSON.stringify(cwd)});
    process.stdout.write(JSON.stringify({ names: [...workflows.keys()], broken }) + "\\n");`;
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lister", version: "1" } } };

  const listed = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", lister], {
    input: JSON.stringify(initialize) + "\n",
    encoding: "utf8",
    timeout: 60_000,
  });

  const lines = listed.stdout.trim().split("\n");
  assert.equal(lines.length, 1, listed.stdout);
  const { names, broken } = JSON.parse(lines[0]!);
  assert.ok(names.includes("explore-db"));
  assert.deepEqual(broken, []);
});

const serverAnswering = (answers: Record<string, unknown>) => `
  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import { z } from "zod";
  const answers = ${JSON.stringify(answers)};
  const server = new McpServer({ name: "stub", version: "1" }, { capabilities: { tools: {} } });
  for (const tool of Object.keys(answers)) {
    server.registerTool(tool, { description: tool, inputSchema: z.looseObject({}) }, async () => ({ content: [{ type: "text", text: JSON.stringify(answers[tool]) }] }));
  }
  await server.connect(new StdioServerTransport());
`;

test("a database server that cannot start ends the run as failed and names the call that failed, with no review of an empty schema", async () => {
  const withoutItsServer = await copyOfWorkflow();
  const run = await runWorkflow(withoutItsServer, { mode: "review" }, { cwd, metricsDb: false });

  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /^list tables: /);
  assert.equal(calls.length, 0);
});

const VALID_ANSWERS = {
  list_tables: ["items"],
  describe_table: { table: "items", columns: [], indexes: [], foreignKeys: [] },
  query: { rows: [{ rows: 4 }] },
};

for (const [tool, failedCall] of [["list_tables", "list tables"], ["describe_table", "describe items"], ["query", "count items"]]) {
  test(`an answer of ${tool} that is not the expected shape ends the run as failed and names the call, before any agent runs`, async () => {
    const withStubServer = await copyOfWorkflow(serverAnswering({ ...VALID_ANSWERS, [tool!]: "not what the tool promises" }));
    const run = await runWorkflow(withStubServer, { mode: "review" }, { cwd, metricsDb: false });

    assert.equal(run.status, "failed");
    assert.equal(run.error, `${failedCall}: unexpected answer`);
    assert.equal(calls.length, 0);
  });
}

test("a stub server with every answer in the expected shape lets the review go on", async () => {
  scriptReviewers();
  const withStubServer = await copyOfWorkflow(serverAnswering(VALID_ANSWERS));
  const run = await runWorkflow(withStubServer, { mode: "review" }, { cwd, metricsDb: false });

  assert.equal(run.status, "finished", run.error);
  assert.deepEqual((run.result as { report: { tables: unknown } }).report.tables, [{ table: "items", rows: 4 }]);
});
