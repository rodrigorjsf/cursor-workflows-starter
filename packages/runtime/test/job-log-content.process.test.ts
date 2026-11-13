// Seam: the process. A detached job (`wf start`, then `wf wait`) runs a workflow against the fake Cursor SDK in a temporary
// repo; its job log (`.workflows/jobs/<jobId>.log`, the child's stdout and stderr) is read back next to the run's event log.
// The content retention (retention.ts) prunes step content from the event log only, so it holds only if the job log never
// receives step content in the first place.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eventLogPath } from "../src/runtime/run-store.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let repo: string;
let env: Record<string, string>;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-job-log-"));
  repo = join(sandbox, "repo");
  mkdirSync(join(repo, ".agents", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".agents", "workflows", "speak.mjs"),
    `export default {
  meta: { name: "speak", description: "speak fixture" },
  defaults: { model: { id: "m" } },
  async run(ctx) {
    await ctx.agent("PROMPT-MARKER-7f3a", { label: "speak" });
    await ctx.exec("node", ["-e", "console.log('OUTPUT-MARKER-' + '7f3a')"], { label: "echo" });
    return { status: "done" };
  },
};
`,
  );
  env = {
    ...(getDefaultEnvironment() as Record<string, string>),
    TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"),
    WF_HOME: join(sandbox, "home"),
    WF_METRICS: "off",
    WF_DASH_AUTOSTART: "off",
    WF_CWD: repo,
  };
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

function wf(...args: string[]): Record<string, any> {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), ...args, "--cwd", repo], { env, encoding: "utf8" });
  return JSON.parse(r.stdout);
}

test("a job's log carries the run's events but never its step content, so the content retention holds for jobs", () => {
  const started = wf("start", "speak", "--args", "{}");
  const done = wf("wait", started.jobId, "--timeout", "60");
  assert.equal(done.status, "finished", JSON.stringify(done));

  const events = readFileSync(eventLogPath(repo, started.runId), "utf8");
  const jobLog = readFileSync(join(repo, ".workflows", "jobs", `${started.jobId}.log`), "utf8");
  for (const marker of ["PROMPT-MARKER-7f3a", "OUTPUT-MARKER-7f3a"]) {
    assert.ok(events.includes(marker), `${marker} is step content: the event log has it until the retention prunes it`);
    assert.ok(!jobLog.includes(marker), `${marker} must not be in the job log, which nothing prunes`);
  }
  assert.match(jobLog, /"type":"run-end"/, "the job log does carry the run's other events");
  assert.doesNotMatch(jobLog, /"type":"content"/);
});
