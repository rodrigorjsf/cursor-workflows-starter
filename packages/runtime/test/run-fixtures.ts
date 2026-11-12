// Shared by the tests that look at a run after the fact (`wf gc`): what happened to a run in the past is set in its event log.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDirIn } from "../src/runtime/run-store.js";

/** Moves everything the run `runId` of the repo `cwd` did `days` days into the past, as if it had happened then. */
export function ageRunLog(cwd: string, runId: string, days: number): void {
  const file = join(runDirIn(cwd, runId), "events.jsonl");
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as { ts: string };
      return JSON.stringify({ ...event, ts: new Date(Date.parse(event.ts) - days * 86_400_000).toISOString() });
    });
  writeFileSync(file, lines.join("\n") + "\n");
}
