// What the Start panel asks of the dashboard: the repositories it may start a run in, the workflows of one, and the start
// itself. Thin calls over dashboard-api.ts; what the answers hold is typed by the server's own types (src/start.ts).
import type { StartedReply, WorkflowsReply } from "../src/start.js";
import { type ApiReply, getJson, postAction } from "./dashboard-api.js";
import type { StartRequestBody } from "./start-form.js";

/** The repositories the dashboard knows: the only ones it starts a workflow in. */
export const loadRepos = (origin?: string): Promise<ApiReply<{ repos: string[] }>> => getJson("/api/repos", origin);

/** The workflows `repo` lists, each with the text its args box starts with. */
export const loadWorkflows = (repo: string, origin?: string): Promise<ApiReply<WorkflowsReply>> => getJson(`/api/workflows?repo=${encodeURIComponent(repo)}`, origin);

/** Starts the workflow as a job; the answer carries the run's id, which the Run view opens. */
export const postStart = (body: StartRequestBody, origin?: string): Promise<ApiReply<StartedReply>> => postAction("/api/start", body, origin);
