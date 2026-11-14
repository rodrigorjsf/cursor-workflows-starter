// Shared by the dashboard's tests: a throwaway per-user home, throwaway repos with run directories written the way the
// runtime writes them, and an HTTP client that can send any Host header.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface Sandbox {
  /** `WF_HOME`: where the global runs index and the metrics database live. */
  home: string;
  /** Makes a repo directory under the sandbox and returns its absolute path. */
  repo(name: string): string;
  dispose(): void;
}

/** Points `WF_HOME` (and nothing else) at a fresh directory for the length of the test. */
export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "wf-dash-"));
  const home = join(root, "home");
  mkdirSync(home);
  const previous = { home: process.env.WF_HOME, db: process.env.WF_METRICS_DB };
  process.env.WF_HOME = home;
  delete process.env.WF_METRICS_DB;
  return {
    home,
    repo(name) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    dispose() {
      if (previous.home === undefined) delete process.env.WF_HOME;
      else process.env.WF_HOME = previous.home;
      if (previous.db !== undefined) process.env.WF_METRICS_DB = previous.db;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface FixtureRun {
  runId: string;
  workflow: string;
  startedAt: string;
  /** The `phases` the run-start declares (what `meta.phases` lists); left out when not given, as an older kit's log has it. */
  phases?: string[];
  /** Events after the `run-start` (which the helper writes): each is `{type, ...fields}`; `ts`, `runId` and `v` are filled in. */
  events?: Array<{ type: string } & Record<string, unknown>>;
  /** Write the run's lock as held by this pid: a process is executing the run. */
  lockedBy?: number;
  /** The job (`wf start`, `start_workflow`) the `run-start` names as the one that started this execution. */
  jobId?: string;
  /** Register the run in the global index but leave its directory out. */
  withoutLog?: boolean;
}

/** The event log of a run, whether or not it exists yet. */
export function logPath(repo: string, runId: string): string {
  return join(repo, ".workflows", "runs", runId, "events.jsonl");
}

/** One log line (without its newline) the way the runtime writes an event: `v`, `ts` and `runId` first, then the event's own fields. */
export function eventLine(runId: string, ts: string, event: { type: string } & Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ts, runId, ...event });
}

/** Appends raw text to a run's log: a whole line, several, or half of one. */
export function appendLog(repo: string, runId: string, text: string): void {
  appendFileSync(logPath(repo, runId), text);
}

/** Registers a run in the global index and writes its event log under `<repo>/.workflows/runs/<runId>/`. */
export function writeRun(home: string, repo: string, run: FixtureRun): void {
  const at = (n: number) => new Date(Date.parse(run.startedAt) + n * 1000).toISOString();
  writeFileSync(join(home, "runs.jsonl"), `${JSON.stringify({ v: 1, runId: run.runId, repo, workflow: run.workflow, startedAt: run.startedAt })}\n`, { flag: "a" });
  if (run.withoutLog) return;
  const file = logPath(repo, run.runId);
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  const events = [{ type: "run-start", workflow: run.workflow, ...(run.phases ? { phases: run.phases } : {}), ...(run.jobId ? { jobId: run.jobId } : {}) }, ...(run.events ?? [])];
  writeFileSync(file, events.map((e, i) => eventLine(run.runId, at(i), e)).join("\n") + "\n");
  if (run.lockedBy !== undefined) writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: run.lockedBy, token: "fixture", startedAt: run.startedAt, runId: run.runId }));
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** The body parsed as JSON; undefined when it is not JSON. */
  json: any;
}

/** One request to `url` (the server's origin); `host` replaces the Host header, `method` the verb, `headers` adds request headers. */
export function http(url: string, path: string, opts: { host?: string; method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const target = new URL(path, url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: opts.method ?? "GET", headers: { ...(opts.host === undefined ? {} : { host: opts.host }), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    req.end();
  });
}

export interface Frame {
  /** The `id:` field: the event's line number in the log. */
  id?: string;
  /** The `data:` lines, joined with a newline. */
  data: string;
}

export interface Stream {
  status: number;
  headers: Reply["headers"];
  /** Everything the server sent, for a reply that is not a stream (an error body). */
  text(): string;
  /** The next `count` frames after the ones taken so far. Rejects when they do not arrive in `timeoutMs`, or the server ends the stream first. */
  take(count: number, timeoutMs?: number): Promise<Frame[]>;
  /** Waits `ms` and returns the frames that arrived meanwhile (and marks them taken). For asserting that nothing comes. */
  within(ms: number): Promise<Frame[]>;
  /** Resolves when the connection is over, whoever ended it. */
  ended: Promise<void>;
  /** Drops the connection, as a closed tab does. */
  close(): void;
}

function parseFrame(raw: string): Frame | undefined {
  const frame: Frame = { data: "" };
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // a comment
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") frame.id = value;
    else if (field === "data") data.push(value);
  }
  frame.data = data.join("\n");
  return data.length > 0 ? frame : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Opens a Server-Sent Events stream and resolves when the response headers arrive. `host` replaces the Host header; `headers` adds request headers. */
export function openStream(url: string, path: string, opts: { host?: string; headers?: Record<string, string> } = {}): Promise<Stream> {
  const target = new URL(path, url);
  const headers: Record<string, string> = { accept: "text/event-stream", ...(opts.host === undefined ? {} : { host: opts.host }), ...opts.headers };
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, headers }, (res) => {
      res.setEncoding("utf8");
      const frames: Frame[] = [];
      let taken = 0;
      let received = "";
      let pending = "";
      let over = false;
      res.on("data", (chunk: string) => {
        received += chunk;
        pending += chunk;
        for (let cut = pending.indexOf("\n\n"); cut >= 0; cut = pending.indexOf("\n\n")) {
          const frame = parseFrame(pending.slice(0, cut));
          pending = pending.slice(cut + 2);
          if (frame) frames.push(frame);
        }
      });
      const ended = new Promise<void>((done) => {
        res.once("close", () => {
          over = true;
          done();
        });
      });
      res.once("error", () => undefined); // a dropped connection is how the tests end a stream
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => received,
        async take(count, timeoutMs = 3000) {
          const deadline = performance.now() + timeoutMs;
          while (frames.length - taken < count) {
            const have = JSON.stringify(frames.slice(taken));
            if (over) throw new Error(`the stream ended with ${frames.length - taken} of ${count} frames: ${have}`);
            if (performance.now() > deadline) throw new Error(`timed out waiting for ${count} frames, got ${frames.length - taken}: ${have}`);
            await sleep(10);
          }
          taken += count;
          return frames.slice(taken - count, taken);
        },
        async within(ms) {
          await sleep(ms);
          const arrived = frames.slice(taken);
          taken = frames.length;
          return arrived;
        },
        ended,
        close: () => req.destroy(),
      });
    });
    req.once("error", reject);
    req.end();
  });
}

export interface FakeGh {
  /** Pull requests the fake knows: `gh pr view <url>` answers with the state. A url not set answers "no pull requests found" and exits 1. */
  set(url: string, state: "OPEN" | "MERGED" | "CLOSED"): void;
  /** Every argument list `gh` was started with, in order. */
  calls(): string[][];
  /** Puts PATH back and removes the fake. */
  restore(): void;
}

/** A `gh` first on PATH for the length of the test, answering `gh pr view <url> --json state --jq .state` from the states set, and logging each start. */
export function fakeGh(box: Sandbox): FakeGh {
  const dir = box.repo("fake-gh-bin");
  const states = join(dir, "states.txt");
  const log = join(dir, "calls.jsonl");
  writeFileSync(states, "");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const line = fs.readFileSync(${JSON.stringify(states)}, "utf8").split("\\n").find((l) => l.startsWith(args[2] + " "));
if (!line) { process.stderr.write("no pull requests found for " + args[2]); process.exit(1); }
process.stdout.write(line.split(" ")[1] + "\\n");
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;
  return {
    set(url, state) {
      const kept = readFileSync(states, "utf8").split("\n").filter((l) => l && !l.startsWith(`${url} `));
      writeFileSync(states, [...kept, `${url} ${state}`].join("\n") + "\n");
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]),
    restore() {
      process.env.PATH = previous;
    },
  };
}

export interface FakeGlab {
  /** Merge requests the fake knows: `glab api --hostname <host> projects/<path>/merge_requests/<n>` answers with a merge request of this state. A url not set answers "404 Not Found" and exits 1. */
  set(url: string, state: "opened" | "locked" | "merged" | "closed"): void;
  /** Every argument list `glab` was started with, in order, after `NAME=value` for each of `GITLAB_HOST` and the token variables it had. */
  calls(): string[][];
  /** Writes glab's `config.yml`, in the directory `GLAB_CONFIG_DIR` names for the length of the test. */
  config(yaml: string): void;
  /** Puts PATH and `GLAB_CONFIG_DIR` back and removes the fake. */
  restore(): void;
}

/**
 * glab's `config.yml` the way glab 1.130 writes it (4-space indent, comments between the keys, one block per host with its token),
 * for hosts that each have a made-up token. Tests that check no token leaks give each host a token they can search for.
 */
export function glabConfigOf(tokens: Record<string, string>): string {
  const hosts = Object.entries(tokens)
    .map(([host, token]) => `    ${host}:\n        token: ${token}\n        api_host: ${host}\n        git_protocol: ssh\n        api_protocol: https\n        user: someone`)
    .join("\n");
  return `# What protocol to use when performing git operations. Supported values: ssh, https\ngit_protocol: ssh\n# Set to true to disable prompts\nno_prompt: false\nhost: gitlab.com\n# Configuration per host\nhosts:\n${hosts}\n`;
}

/**
 * What the real glab 1.130.0 printed for that command line on a real GitLab, recorded by scripts/verify/gitlab-e2e.sh: the fake
 * answers with the recorded merge request (`mr-api`), its number, state and URL set to the one asked for. A path, not a module:
 * the fake runs as a process of its own.
 */
const GLAB_RECORDINGS = join(import.meta.dirname, "..", "..", "runtime", "test", "fixtures", "glab", "recordings.json");

/**
 * A `glab` first on PATH for the length of the test, answering `glab api --hostname <host> projects/<path>/merge_requests/<n>` (or
 * `GITLAB_HOST=<host> glab api projects/...`; `--hostname` with a port fails, as on the real glab) from the
 * merge requests set (any other command line exits 2) with what the real glab printed (`GLAB_RECORDINGS`), and logging each start;
 * and an empty `GLAB_CONFIG_DIR` for `config()` to fill. Restore it before the `fakeGh` that was made before it: each puts back the
 * PATH it found.
 */
export function fakeGlab(box: Sandbox): FakeGlab {
  const dir = box.repo("fake-glab-bin");
  const configDir = box.repo("glab-config");
  const states = join(dir, "states.txt");
  const log = join(dir, "calls.jsonl");
  writeFileSync(states, "");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "glab"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
// The variables that point glab at a host or carry a token come first in the log, as \`NAME=value\`.
const env = ["GITLAB_HOST", "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"].filter((k) => process.env[k] !== undefined).map((k) => k + "=" + process.env[k]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([...env, ...args]) + "\\n");
const ROUTE = /^projects\\/([^/]+)\\/merge_requests\\/(\\d+)$/;
const byFlag = args.length === 4 && args[0] === "api" && args[1] === "--hostname" && ROUTE.test(args[3]);
const byEnv = args.length === 2 && args[0] === "api" && process.env.GITLAB_HOST !== undefined && ROUTE.test(args[1]);
if (!byFlag && !byEnv) { process.stderr.write("unexpected glab command line"); process.exit(2); }
// glab 1.130.0 takes a bare host in --hostname: with a port it fails before asking anyone, as it did when tried
if (byFlag && args[2].includes(":")) { process.stderr.write("ERROR error parsing --hostname: invalid hostname."); process.exit(1); }
const host = byFlag ? args[2] : process.env.GITLAB_HOST;
const [, project, number] = ROUTE.exec(byFlag ? args[3] : args[1]);
const url = "https://" + host + "/" + decodeURIComponent(project) + "/-/merge_requests/" + number;
const line = fs.readFileSync(${JSON.stringify(states)}, "utf8").split("\\n").find((l) => l.startsWith(url + " "));
if (!line) { process.stderr.write("glab: 404 Not Found"); process.exit(1); }
const REC = JSON.parse(fs.readFileSync(${JSON.stringify(GLAB_RECORDINGS)}, "utf8"));
const recorded = REC.recordings["mr-api"];
const onThisHost = (text) => text.split(REC.placeholders.host).join(host);
process.stderr.write(onThisHost(recorded.stderr));
process.stdout.write(JSON.stringify({ ...JSON.parse(onThisHost(recorded.stdout)), id: 1000 + Number(number), iid: Number(number), state: line.split(" ")[1], web_url: url }) + "\\n");
`,
  );
  chmodSync(join(dir, "glab"), 0o755);
  const previous = { path: process.env.PATH, config: process.env.GLAB_CONFIG_DIR };
  process.env.PATH = `${dir}${delimiter}${previous.path ?? ""}`;
  process.env.GLAB_CONFIG_DIR = configDir;
  return {
    set(url, state) {
      const kept = readFileSync(states, "utf8").split("\n").filter((l) => l && !l.startsWith(`${url} `));
      writeFileSync(states, [...kept, `${url} ${state}`].join("\n") + "\n");
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]),
    config(yaml) {
      writeFileSync(join(configDir, "config.yml"), yaml);
    },
    restore() {
      process.env.PATH = previous.path;
      if (previous.config === undefined) delete process.env.GLAB_CONFIG_DIR;
      else process.env.GLAB_CONFIG_DIR = previous.config;
    },
  };
}
