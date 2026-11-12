// The global runs index: one line per run, across every repo of the user, in `~/.cursor-workflows/runs.jsonl`
// (`WF_HOME` moves the directory). It is how a tool that is not inside a repo (the dashboard) finds runs: the entry
// names the repo, and the run's own state lives in `<repo>/.workflows/runs/<runId>/`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { userDir } from "./state.js";
import { appendJsonl, readJsonl } from "./state-files.js";

/** Schema version of an index line. Independent of the events' version: they change for different reasons. */
export const RUNS_INDEX_VERSION = 1;

export interface RunsIndexEntry {
  /** Schema version of this line. */
  v: number;
  runId: string;
  /** Absolute path of the repo the run executes in (the directory that holds `.workflows/`). */
  repo: string;
  workflow: string;
  /** When the run first started, ISO 8601 UTC. A resume does not add a line. Readers that need one line per run dedupe by `runId`. */
  startedAt: string;
}

export function runsIndexPath(): string {
  return join(userDir(), "runs.jsonl");
}

export function registerRun(entry: Omit<RunsIndexEntry, "v">): void {
  mkdirSync(userDir(), { recursive: true, mode: 0o700 });
  appendJsonl(runsIndexPath(), { v: RUNS_INDEX_VERSION, ...entry } satisfies RunsIndexEntry);
}

const isEntry = (v: unknown): v is RunsIndexEntry =>
  typeof v === "object" && v !== null && typeof (v as { runId?: unknown }).runId === "string" && typeof (v as { repo?: unknown }).repo === "string";

/** Every run registered so far, oldest first. A torn or unreadable line is skipped. */
export function readRunsIndex(): RunsIndexEntry[] {
  return readJsonl(runsIndexPath(), isEntry).records;
}
