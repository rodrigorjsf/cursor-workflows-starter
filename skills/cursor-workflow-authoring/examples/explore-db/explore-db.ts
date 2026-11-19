import { join } from "node:path";
import type { McpStdioServer, WorkflowContext, WorkflowDefinition } from "../../../../packages/runtime/src/runtime/workflow.js";

const AXES = ["indexes", "naming", "normalization"] as const;
const SEVERITIES = ["high", "medium", "low"] as const;

type Axis = (typeof AXES)[number];
type Severity = (typeof SEVERITIES)[number];

interface Args {
  mode: "review" | "interview";
  answers?: Record<string, string>;
}

interface TableSchema {
  table: string;
  rows: number;
  columns: unknown[];
  indexes: unknown[];
  foreignKeys: unknown[];
}

interface Question {
  id: string;
  text: string;
  options: string[];
}

interface Finding {
  table: string;
  category: string;
  severity: Severity;
  problem: string;
  fix: string;
}

const COMPOSER = { id: "composer-2.5" };

const DATABASE_SERVER: McpStdioServer = { command: process.execPath, args: [join(import.meta.dirname, "fake-db-server.mjs")] };

const AXIS_INSTRUCTIONS: Record<Axis, string> = {
  indexes: "Review the database schema below for index problems: foreign keys with no index, redundant indexes, columns a lookup would filter on with no index. Report only what the schema shows.",
  naming: "Review the database schema below for naming problems: mixed letter case, the same key named two ways, names that do not say what the column holds. Report only what the schema shows.",
  normalization: "Review the database schema below for normalization problems: values repeated across rows, columns derived from another table, repeating groups. Report only what the schema shows.",
};

const CATEGORIES: Record<Axis, string[]> = {
  indexes: ["unindexed-foreign-key", "redundant-index", "missing-lookup-index"],
  naming: ["inconsistent-case", "inconsistent-key-name", "ambiguous-name"],
  normalization: ["repeated-value", "derived-column", "repeating-group"],
};

const QUESTIONNAIRE_INSTRUCTIONS =
  "Propose a short questionnaire that tells what the person wants from a review of the database schema below. Ask at most five questions, each with two to four answers to pick from, and nothing the schema already answers.";

const QUESTIONNAIRE_SCHEMA = {
  type: "object",
  required: ["questions"],
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        required: ["id", "text", "options"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
          text: { type: "string" },
          options: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
        },
      },
    },
  },
};

const REPORT_INSTRUCTIONS =
  "Write a review of the database schema below, shaped by the person's answers to the questionnaire: put first what they asked for and leave out what they said does not matter.";

const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "recommendations"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        required: ["table", "advice"],
        additionalProperties: false,
        properties: { table: { type: "string" }, advice: { type: "string" } },
      },
    },
  },
};

const findingsSchema = (categories: string[]) => ({
  type: "object",
  required: ["findings"],
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["table", "category", "severity", "problem", "fix"],
        additionalProperties: false,
        properties: {
          table: { type: "string" },
          category: { enum: categories },
          severity: { enum: [...SEVERITIES] },
          problem: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
  },
});

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const schemaBlockOf = (schema: TableSchema[]) => `## Schema\n${JSON.stringify(schema, null, 2)}`;

const quotedIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

const isTableDescription = (value: unknown): value is Omit<TableSchema, "rows"> =>
  isRecord(value) && typeof value.table === "string" && Array.isArray(value.columns) && Array.isArray(value.indexes) && Array.isArray(value.foreignKeys);

const rowCountOf = (queryAnswer: unknown): number | undefined => {
  const firstRow = isRecord(queryAnswer) && Array.isArray(queryAnswer.rows) ? queryAnswer.rows[0] : undefined;
  return isRecord(firstRow) && typeof firstRow.rows === "number" ? firstRow.rows : undefined;
};

const unexpectedAnswer = (label: string) => new Error(`${label}: unexpected answer`);

async function collectSchema(ctx: WorkflowContext<Args>): Promise<TableSchema[]> {
  const call = async (tool: string, args: Record<string, unknown>, label: string): Promise<unknown> => {
    const result = await ctx.mcp(DATABASE_SERVER, tool, args, { label, phase: "Collect" });
    if (!result.ok) throw new Error(`${label}: ${result.error}`);
    return JSON.parse(result.text);
  };
  const tables = await call("list_tables", {}, "list tables");
  if (!isStringArray(tables)) throw unexpectedAnswer("list tables");
  const schema: TableSchema[] = [];
  for (const table of tables) {
    const description = await call("describe_table", { table }, `describe ${table}`);
    if (!isTableDescription(description)) throw unexpectedAnswer(`describe ${table}`);
    const rows = rowCountOf(await call("query", { sql: `SELECT COUNT(*) AS rows FROM ${quotedIdentifier(table)}` }, `count ${table}`));
    if (rows === undefined) throw unexpectedAnswer(`count ${table}`);
    schema.push({ ...description, rows });
  }
  return schema;
}

async function review(ctx: WorkflowContext<Args>, schema: TableSchema[]) {
  ctx.phase("Review");
  const schemaBlock = schemaBlockOf(schema);
  const reports = await ctx.parallel(
    AXES.map((axis) => () =>
      ctx.agent<{ findings: Finding[] }>(`${AXIS_INSTRUCTIONS[axis]}\n\n${schemaBlock}`, {
        label: `review:${axis}`,
        phase: "Review",
        role: "review",
        tools: [],
        settingSources: [],
        schema: findingsSchema(CATEGORIES[axis]),
        memo: true,
      }),
    ),
  );
  const failedAxes = AXES.filter((_, index) => reports[index] === null);
  if (failedAxes.length) return { status: "review-failed", failedAxes };

  const findings = AXES.flatMap((axis, index) => reports[index]!.findings.map((finding) => ({ axis, ...finding })));
  const withSeverity = (severity: Severity) => findings.filter((finding) => finding.severity === severity);
  ctx.metric("tables", schema.length);
  ctx.metric("findings_high", withSeverity("high").length);
  return {
    status: "done",
    mode: "review",
    report: {
      tables: schema.map(({ table, rows }) => ({ table, rows })),
      mustFix: withSeverity("high"),
      shouldFix: withSeverity("medium"),
      notes: withSeverity("low"),
    },
  };
}

function checkpointOf(ctx: WorkflowContext<Args>, questions: Question[]) {
  const answersTemplate = Object.fromEntries(questions.map((question) => [question.id, question.options.join(" | ")]));
  const next = `npm run wf -- run explore-db --args ${shellQuote(JSON.stringify({ mode: "interview", answers: answersTemplate }))} --resume ${ctx.runId}`;
  return { runId: ctx.runId, questions, next };
}

function answerProblems(questions: Question[], answers: Record<string, string>): string[] {
  const problemsOfAnswer = (question: Question) => {
    const answer = answers[question.id];
    if (answer === undefined) return [`${question.id}: no answer`];
    return question.options.includes(answer) ? [] : [`${question.id}: "${answer}" is not one of ${question.options.join(", ")}`];
  };
  const unknownIds = Object.keys(answers).filter((id) => !questions.some((question) => question.id === id));
  return [...questions.flatMap(problemsOfAnswer), ...unknownIds.map((id) => `${id}: no such question`)];
}

async function interview(ctx: WorkflowContext<Args>, schema: TableSchema[]) {
  ctx.phase("Interview");
  const { questions } = await ctx.agent<{ questions: Question[] }>(`${QUESTIONNAIRE_INSTRUCTIONS}\n\n${schemaBlockOf(schema)}`, {
    label: "questionnaire",
    phase: "Interview",
    role: "questionnaire",
    tools: [],
    settingSources: [],
    schema: QUESTIONNAIRE_SCHEMA,
    memo: true,
  });
  ctx.metric("tables", schema.length);
  ctx.metric("questions", questions.length);
  const { answers } = ctx.args;
  if (!answers) return { status: "questions-proposed", mode: "interview", ...checkpointOf(ctx, questions) };
  const problems = answerProblems(questions, answers);
  if (problems.length) return { status: "questions-proposed", mode: "interview", problems, ...checkpointOf(ctx, questions) };

  ctx.phase("Report");
  const answered = questions.map((question) => `${question.text}: ${answers[question.id]}`).join("\n");
  const report = await ctx.agent<{ summary: string; recommendations: Array<{ table: string; advice: string }> }>(
    `${REPORT_INSTRUCTIONS}\n\n${schemaBlockOf(schema)}\n\n## Answers\n${answered}`,
    { label: "report", phase: "Report", role: "report", tools: [], settingSources: [], schema: REPORT_SCHEMA, memo: true },
  );
  return { status: "done", mode: "interview", answers, report };
}

export default {
  meta: {
    name: "explore-db",
    description: "Explores a database through an MCP server: a review of its schema by axes, or an interview that proposes questions first.",
    whenToUse: "When the user asks to review a database schema, or to explore a database and be asked what matters first.",
    phases: [{ title: "Collect" }, { title: "Review" }, { title: "Interview" }, { title: "Report" }],
    roles: [
      { name: "review", description: "Reviews the schema on one axis.", cloud: "read-only", defaults: { model: COMPOSER, settingSources: [] } },
      { name: "questionnaire", description: "Proposes the questions the person answers.", cloud: "read-only", defaults: { model: COMPOSER, settingSources: [] } },
      { name: "report", description: "Writes the review the answers asked for.", cloud: "read-only", defaults: { model: COMPOSER, settingSources: [] } },
    ],
    argsSchema: {
      type: "object",
      required: ["mode"],
      additionalProperties: false,
      properties: {
        mode: { enum: ["review", "interview"] },
        answers: { type: "object", additionalProperties: { type: "string" } },
      },
      dependencies: { answers: { properties: { mode: { const: "interview" } } } },
    },
  },
  defaults: { model: COMPOSER, timeoutMs: 5 * 60_000 },
  budget: { maxTokens: 300_000 },

  async run(ctx) {
    ctx.phase("Collect");
    const schema = await collectSchema(ctx);
    return ctx.args.mode === "review" ? review(ctx, schema) : interview(ctx, schema);
  },
} satisfies WorkflowDefinition<Args>;
