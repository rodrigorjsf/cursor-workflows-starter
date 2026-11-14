// WHAT: Runs the real `gh` for the one forge command the dashboard's Backlog sends it, `gh issue list` (the forge module,
//   packages/runtime/workflows/implement-issue/forge.ts, `listIssues`), against a real GitHub repository, and writes what gh printed,
//   with the repository's `owner/name` replaced by `owner/repo`, to packages/runtime/test/fixtures/gh/recordings.json. The fake `gh`
//   of the dashboard's tests reads that file. It only reads: nothing is created on GitHub.
// WHY: a fake of an external CLI answers from a recording of the real tool (CODING_STANDARDS, Testing): the argument list the forge
//   sends and the JSON gh prints for it are what the fake accepts and prints, never what someone remembered of gh's documentation.
// WHEN: after changing the `gh issue list` command line in forge.ts, or to try a newer gh. Needs `gh auth login`, and at least two
//   open issues with the label (default `ready-for-agent`) in the repository, so that the recording shows how gh prints a list of issues.
// HOW: `npx tsx scripts/verify/record-gh-fixtures.ts` in a clone of the repository to read (a GitHub origin), or with `--repo
//   <owner/name>`; `GH_RECORD_LABEL=<label>` picks the label. Prints where it wrote; exits 1 and writes nothing when the repository
//   has fewer than two open issues with the label, or when a recording still holds a credential.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { errorText } from "../../packages/runtime/src/runtime/error-text.js";
import { createRedactor } from "../../packages/runtime/src/runtime/redaction.js";
import { directCommands } from "../../packages/runtime/workflows/implement-issue/gc.js";
import { createForge } from "../../packages/runtime/workflows/implement-issue/forge.js";
import { isEntryPoint } from "../lib/cli.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
/** Where the fake `gh` of the dashboard's tests reads the recordings. */
export const GH_RECORDINGS_PATH = join(ROOT, "packages", "runtime", "test", "fixtures", "gh", "recordings.json");

/** What replaces the repository the recording was made on. */
export const REPO_PLACEHOLDER = "owner/repo";
/** A label no issue carries: the recording of an empty list. */
const NO_SUCH_LABEL = "no-issue-has-this-label";

/** One run of gh: its arguments, how it ended, and what it printed. */
export interface GhRecording {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The file the fake `gh` reads. */
export interface GhRecordingsFile {
  /** The gh the recordings came from. */
  recordedWith: { gh: string };
  /** What stands for the recorded repository in the outputs. */
  placeholders: { repo: string };
  recordings: Record<string, GhRecording>;
}

/** The gh that wraps the real one: it runs it, keeps what it printed beside the call, and prints the same. The forge module calls it by name. */
const WRAPPER = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readdirSync, writeFileSync } = require("node:fs");
const dir = process.env.WF_RECORD_DIR;
const args = process.argv.slice(2);
const r = spawnSync(process.env.WF_REAL_GH, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["inherit", "pipe", "pipe"] });
writeFileSync(dir + "/" + String(readdirSync(dir).length).padStart(4, "0") + ".json", JSON.stringify({ args, exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.status ?? 1;
`;

/** The `gh` calls `run` makes, each as the recording it is. */
async function recordCalls(run: () => Promise<unknown>): Promise<GhRecording[]> {
  const scratch = mkdtempSync(join(tmpdir(), "wf-gh-record-"));
  const calls = join(scratch, "calls");
  mkdirSync(calls);
  writeFileSync(join(scratch, "gh"), WRAPPER);
  chmodSync(join(scratch, "gh"), 0o755);
  const previous = { path: process.env.PATH, record: process.env.WF_RECORD_DIR, real: process.env.WF_REAL_GH };
  process.env.WF_REAL_GH = execFileSync("which", ["gh"], { encoding: "utf8" }).trim();
  process.env.WF_RECORD_DIR = calls;
  process.env.PATH = `${scratch}${delimiter}${previous.path ?? ""}`;
  try {
    await run();
    return readdirSync(calls).map((name) => JSON.parse(readFileSync(join(calls, name), "utf8")) as GhRecording);
  } finally {
    for (const [key, value] of [["PATH", previous.path], ["WF_RECORD_DIR", previous.record], ["WF_REAL_GH", previous.real]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The recordings of `gh issue list` for `label` and for a label no issue has, made in `cwd`, whose origin names the repository. */
export async function record(cwd: string, label: string, repo: string): Promise<GhRecordingsFile> {
  const forge = createForge("github", directCommands());
  const listed: Array<{ number: number }> = [];
  const [full, empty] = [
    ...(await recordCalls(async () => listed.push(...(await forge.listIssues(cwd, label))))),
    ...(await recordCalls(() => forge.listIssues(cwd, NO_SUCH_LABEL))),
  ];
  if (listed.length < 2) throw new Error(`${repo} has ${listed.length} open issue(s) labelled ${label}: the recording needs at least two, to show how gh prints a list of them (GH_RECORD_LABEL names another label)`);
  const scrub = (text: string) => createRedactor({ env: {} }).text(text.split(repo).join(REPO_PLACEHOLDER));
  const version = /^gh version (\S+)/.exec(execFileSync("gh", ["--version"], { encoding: "utf8" }))?.[1] ?? "unknown";
  const file: GhRecordingsFile = {
    recordedWith: { gh: version },
    placeholders: { repo: REPO_PLACEHOLDER },
    recordings: Object.fromEntries(
      Object.entries({ "issue-list": full!, "issue-list-empty": empty! }).map(([name, r]) => [name, { args: r.args.map(scrub), exitCode: r.exitCode, stdout: scrub(r.stdout), stderr: scrub(r.stderr) }]),
    ),
  };
  if (repo !== "" && JSON.stringify(file).includes(repo)) throw new Error("a recording still names the repository: nothing was written");
  return file;
}

/** The whole recording; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf("--repo");
  const repo = at === -1 ? execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim() : (argv[at + 1] ?? "");
  const file = await record(process.cwd(), process.env.GH_RECORD_LABEL ?? "ready-for-agent", repo);
  mkdirSync(dirname(GH_RECORDINGS_PATH), { recursive: true });
  const partial = `${GH_RECORDINGS_PATH}.partial`;
  writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(partial, GH_RECORDINGS_PATH);
  process.stdout.write(`wrote ${GH_RECORDINGS_PATH} (${Object.keys(file.recordings).length} recordings, gh ${file.recordedWith.gh})\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${errorText(err)}\n`);
      process.exitCode = 1;
    },
  );
}
