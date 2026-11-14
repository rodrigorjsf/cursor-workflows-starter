// What the dashboard's Start action says to the browser and takes from it, apart from the HTTP plumbing (server.ts): the body of
// `POST /api/start` checked into a request, the runtime's answer turned into a status and a sentence, and the skeleton the
// args box is pre-filled with. Pure: no clock, no network, no disk; the runtime does the starting (`startRun`, observe).
//
// It decides nothing about what may start: the repository and the workflow are resolved by the runtime from the runs index and
// its own workflow listing, and the args are checked there against the workflow's `argsSchema`. What is checked here is the
// shape of the request, so a refusal for a missing cap or a body that is not JSON never reaches the runtime.
import { type StartRunOutcome, type StartRunRequest, type StartableWorkflow, errorText } from "@cursor-workflows/runtime/observe";

type StartRunOutcomeStarted = Extract<StartRunOutcome, { kind: "started" }>;

/** The most a start request may weigh. The args are a hand-typed JSON; anything larger is not one. */
export const MAX_START_BODY_BYTES = 256 * 1024;

export type ParsedStart = { ok: true; request: StartRunRequest } | { ok: false; error: string };

/** What `POST /api/start` answers (202) when the job started. `violations` are what the global caps cut, and is left out when nothing was cut. */
export interface StartedReply {
  jobId: string;
  runId: string;
  repo: string;
  workflow: string;
  violations?: StartRunOutcomeStarted["violations"];
}

/** A workflow as the start form lists it (`GET /api/workflows`): what it is, and what its args box starts with. */
export interface WorkflowEntry {
  name: string;
  description: string;
  whenToUse?: string;
  /** The text the args box starts with, as an object: each required field set to a blank of its type (see `argsSkeleton`). */
  argsSkeleton: Record<string, unknown>;
  /** The fields of the args the skeleton leaves out because they are not required. */
  optionalArgs: string[];
}

/** What `GET /api/workflows?repo=` answers: the repository's workflows, and the files of its workflows that did not load. */
export interface WorkflowsReply {
  repo: string;
  workflows: WorkflowEntry[];
  broken: Array<{ file: string; error: string }>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `maxTokens` or `maxCents` of the body: a number above 0, or the sentence that says what is wrong with it. */
function capOf(body: Record<string, unknown>, field: "maxTokens" | "maxCents"): number | string {
  const value = body[field];
  if (value === undefined || value === null) return `${field} is required: a start from the dashboard always carries both caps, maxTokens and maxCents`;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a number`;
  if (value <= 0) return `${field} must be a number greater than 0`;
  return value;
}

/** The request a body (`raw`, the text received) holds, or why it is not one. Args left out are `{}`. */
export function parseStartBody(raw: string): ParsedStart {
  const shape = "the request body must be a JSON object with repo, workflow, args, maxTokens and maxCents";
  if (raw.trim() === "") return { ok: false, error: shape };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `the request body is not valid JSON: ${errorText(err)}` };
  }
  if (!isObject(body)) return { ok: false, error: shape };
  const { repo, workflow, args = {} } = body;
  if (repo === undefined || repo === "") return { ok: false, error: "repo is required: the path of a repository the dashboard knows" };
  if (typeof repo !== "string") return { ok: false, error: "repo must be text: the path of a repository the dashboard knows" };
  if (workflow === undefined || workflow === "") return { ok: false, error: "workflow is required: the name of a workflow the repository lists" };
  if (typeof workflow !== "string") return { ok: false, error: "workflow must be text: the name of a workflow the repository lists" };
  if (!isObject(args)) return { ok: false, error: "args must be a JSON object" };
  const maxTokens = capOf(body, "maxTokens");
  if (typeof maxTokens === "string") return { ok: false, error: maxTokens };
  const maxCents = capOf(body, "maxCents");
  if (typeof maxCents === "string") return { ok: false, error: maxCents };
  return { ok: true, request: { repo, workflow, args, maxTokens, maxCents } };
}

/** What the server answers for a repository it does not know. */
export const unknownRepoError = (repo: string): string =>
  `unknown repository: ${repo}; the dashboard starts workflows only in repositories whose runs it already knows: start one there from the chat or with \`wf start\` first`;

/** The status and the body the runtime's answer to a start becomes. A start that worked is 202: the job runs on its own, and its run registers itself a moment later. */
export function startReply(outcome: StartRunOutcome, request: StartRunRequest): { status: number; body: StartedReply | { error: string } } {
  switch (outcome.kind) {
    case "started":
      return { status: 202, body: { jobId: outcome.jobId, runId: outcome.runId, repo: request.repo, workflow: request.workflow, ...(outcome.violations.length > 0 ? { violations: outcome.violations } : {}) } };
    case "unknown-repo":
      return { status: 404, body: { error: unknownRepoError(request.repo) } };
    case "unknown-workflow":
      return { status: 404, body: { error: `unknown workflow: ${request.workflow}; this repository lists: ${outcome.available.join(", ") || "no workflows"}` } };
    case "invalid-args":
      return { status: 400, body: { error: outcome.error } };
    case "refused":
      return { status: 409, body: { error: outcome.error } };
  }
}

/** The value a schema suggests for a field the user must fill in: its default, its first enum value, or an empty one of its type that the schema will turn down. */
function placeholder(schema: unknown): unknown {
  if (!isObject(schema)) return null;
  if ("default" in schema) return schema.default;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = (Array.isArray(schema.type) ? schema.type : [schema.type]).find((t) => t !== "null");
  switch (type) {
    case "string":
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return argsSkeleton(schema);
    default:
      return null;
  }
}

/**
 * The args box's starting text for a workflow: an object with each field the `argsSchema` requires, set to a blank of its type
 * (`""`, `0`, `false`, `[]`, `{}`) or to the schema's own default. A blank is one the schema turns down when it has a minimum or a
 * length, on purpose: a field the user forgot to fill in fails the check instead of starting a run on a made-up value. Fields that
 * are not required are left out (`optionalArgs` names them); `{}` when the workflow declares no schema.
 */
export function argsSkeleton(schema: unknown): Record<string, unknown> {
  if (!isObject(schema) || !isObject(schema.properties)) return {};
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  return Object.fromEntries(required.map((name) => [name, placeholder((schema.properties as Record<string, unknown>)[name])]));
}

/** The fields of the schema's top level that are not required: what the box's hint offers on top of the skeleton. */
function optionalArgs(schema: unknown): string[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(schema.properties).filter((name) => !required.has(name));
}

export function workflowEntry({ name, description, whenToUse, argsSchema }: StartableWorkflow): WorkflowEntry {
  return { name, description, ...(whenToUse === undefined ? {} : { whenToUse }), argsSkeleton: argsSkeleton(argsSchema), optionalArgs: optionalArgs(argsSchema) };
}
