// What the Start panel asks of the dashboard: the repositories it may start a run in, the workflows of one, and the start
// itself. Thin calls over dashboard-api.ts; what the answers hold is typed by the server's own types (src/start.ts) and checked
// against them before the panel reads it.
import type { StartedReply, WorkflowEntry, WorkflowsReply } from "../src/start.js";
import { type ApiReply, getJson, postAction } from "./dashboard-api.js";
import { isRecord, isTextList } from "./is-record.js";
import type { StartRequestBody } from "./start-form.js";


const isReposReply = (value: unknown): value is { repos: string[] } => isRecord(value) && isTextList(value.repos);

const isWorkflowEntry = (value: unknown): value is WorkflowEntry =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  (value.whenToUse === undefined || typeof value.whenToUse === "string") &&
  isRecord(value.argsSkeleton) &&
  isTextList(value.optionalArgs);

const isWorkflowsReply = (value: unknown): value is WorkflowsReply =>
  isRecord(value) &&
  typeof value.repo === "string" &&
  Array.isArray(value.workflows) &&
  value.workflows.every(isWorkflowEntry) &&
  Array.isArray(value.broken) &&
  value.broken.every((entry) => isRecord(entry) && typeof entry.file === "string" && typeof entry.error === "string");

const isStartedReply = (value: unknown): value is StartedReply =>
  isRecord(value) &&
  typeof value.jobId === "string" &&
  typeof value.runId === "string" &&
  typeof value.repo === "string" &&
  typeof value.workflow === "string" &&
  (value.violations === undefined || Array.isArray(value.violations));

/** The repositories the dashboard knows: the only ones it starts a workflow in. */
export const loadRepos = (origin?: string): Promise<ApiReply<{ repos: string[] }>> => getJson("/api/repos", isReposReply, origin);

/** The workflows `repo` lists, each with the text its args box starts with. */
export const loadWorkflows = (repo: string, origin?: string): Promise<ApiReply<WorkflowsReply>> => getJson(`/api/workflows?repo=${encodeURIComponent(repo)}`, isWorkflowsReply, origin);

/** Starts the workflow as a job; the answer carries the run's id, which the Run view opens. */
export const postStart = (body: StartRequestBody, origin?: string): Promise<ApiReply<StartedReply>> => postAction("/api/start", isStartedReply, body, origin);
