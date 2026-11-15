// What the Run view reads of `GET /api/runs/<runId>`. The answer is untrusted JSON until `parseRunDetail` has looked at it: a
// dashboard of another version (or something else on the port) gives no detail, and a field of the wrong type is left out. Pure.
import { isRecord } from "../app/is-record.js";
import type { JobStart } from "./resume-command.js";
import { type SeamsProposalInfo, isSeamsProposal } from "./seams-form.js";
import type { ApiStatus } from "./use-run-events.js";

const API_STATUSES: readonly ApiStatus[] = ["running", "finished", "failed", "cancelled", "missing"];

export interface RunDetail {
  status: ApiStatus;
  error?: string;
  workflow?: string;
  repo?: string;
  start?: JobStart;
  seamsProposal?: SeamsProposalInfo;
}

const isApiStatus = (value: unknown): value is ApiStatus => API_STATUSES.some((status) => status === value);
const optionalNumber = (value: unknown): boolean => value === undefined || typeof value === "number";
const isJobStart = (value: unknown): value is JobStart =>
  isRecord(value) && "args" in value && optionalNumber(value.maxCents) && optionalNumber(value.maxTokens) && (value.overrides === undefined || isRecord(value.overrides));
const textOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The run's detail, or undefined when the body has no status the API gives. */
export function parseRunDetail(value: unknown): RunDetail | undefined {
  if (!isRecord(value) || !isApiStatus(value.status)) return undefined;
  return {
    status: value.status,
    error: textOf(value.error),
    workflow: textOf(value.workflow),
    repo: textOf(value.repo),
    start: isJobStart(value.start) ? value.start : undefined,
    seamsProposal: isSeamsProposal(value.seamsProposal) ? value.seamsProposal : undefined,
  };
}
