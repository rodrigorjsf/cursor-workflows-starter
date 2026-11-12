// Worker thread of a running job: refreshes the heartbeat in the job record on its own event loop, so the heartbeat keeps
// beating while the job's main thread is blocked in a synchronous call (a test run started with execFileSync, say).
// Plain JavaScript on purpose: it needs nothing but node:fs, and a worker must not depend on the TypeScript loader.
//
// workerData: { file: the job record's path, record: the job record as it is when the job starts, intervalMs }
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { workerData } from "node:worker_threads";

const { file, record, intervalMs } = workerData;

function beat() {
  // Atomic, like every state file (see state-files.ts): temp file next to the target, then rename over it.
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.heartbeat.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ ...record, heartbeat: new Date().toISOString() }, null, 2));
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true }); // the next beat tries again
  }
}

setInterval(beat, intervalMs);
