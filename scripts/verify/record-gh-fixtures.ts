// WHAT: Runs the real `gh` for the forge commands the fakes cannot take from gh's own `--json` output, against a real GitHub
//   repository: `gh issue list` (the dashboard's Backlog, `listIssues` in the forge module,
//   packages/runtime/workflows/implement-issue/forge.ts) and `gh api repos/.../issues/<n> --jq .author_association` (the author gate of
//   `implement-issue`, `authorStanding`), the latter for the repository of the cwd, for a named one and for one named by its URL, and
//   `gh api -i --silent user` (the response headers `wf doctor` reads the token's scopes from, `readTokenScopes`). It writes what gh printed, with
//   the repository's `owner/name` replaced by `owner/repo` and the per-request and per-account headers neutralised, to
//   packages/runtime/test/fixtures/gh/recordings.json. The fake `gh` of the dashboard's tests, the one of the `implement-issue` tests and the
//   one of the doctor's tests read that file. It also records `gh repo view <url> --json visibility -q .visibility` (`remoteVisibility`,
//   packages/runtime/src/runtime/remote-visibility.ts: what the cloud snapshot guard asks) for a public repository, a private one and a URL
//   on a host that is not GitHub. It only reads: nothing is created on GitHub.
// WHY: a fake of an external CLI answers from a recording of the real tool (CODING_STANDARDS, Testing): the argument list the forge
//   sends and what gh prints for it are what the fake accepts and prints, never what someone remembered of gh's documentation.
// WHEN: after changing the `gh issue list` or the `gh api` command line in forge.ts, or to try a newer gh. Needs `gh auth login`, and at
//   least two open issues with the label (default `ready-for-agent`) in the repository, so that the recording shows how gh prints a list
//   of issues; the author of the first one is the one `gh api` reads. Also needs a private repository of the logged-in account, to record
//   how gh prints "PRIVATE" (`--private-repo <owner/name>` or `GH_RECORD_PRIVATE_REPO`; only its answer is kept, never its name).
// HOW: `npx tsx scripts/verify/record-gh-fixtures.ts` in a clone of the repository to read (a GitHub origin), or with `--repo
//   <owner/name>` and `--private-repo <owner/name>`; `GH_RECORD_LABEL=<label>` picks the label. Prints where it wrote; exits 1 and writes
//   nothing when the repository has fewer than two open issues with the label, when no private repository was named, or when a recording
//   still holds a credential.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { errorText } from "../../packages/runtime/src/runtime/error-text.js";
import { createRedactor } from "../../packages/runtime/src/runtime/redaction.js";
import { directCommands } from "../../packages/runtime/workflows/implement-issue/gc.js";
import { createForge, loginOf } from "../../packages/runtime/workflows/implement-issue/forge.js";
import { readTokenScopes } from "../../packages/runtime/src/github-token-scopes.js";
import { remoteVisibility } from "../../packages/runtime/src/runtime/remote-visibility.js";
import { isEntryPoint } from "../lib/cli.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
/** Where the fake `gh` of the dashboard's tests reads the recordings. */
export const GH_RECORDINGS_PATH = join(ROOT, "packages", "runtime", "test", "fixtures", "gh", "recordings.json");

/** The names of the recordings of `gh api ... .author_association`: for the cwd's repository, for one named as `owner/name`, and for one named by its URL. */
export const AUTHOR_RECORDING = { cwd: "issue-author-association", repo: "issue-author-association-repo", url: "issue-author-association-url" } as const;

/** The name of the recording of `gh api -i --silent user`, made for github.com: the headers a token's scopes are read from. */
export const TOKEN_SCOPES_RECORDING = "token-scopes";

/** The names of the recordings of `gh repo view --json visibility`: a public repository, a private one, and a URL gh cannot answer for. */
export const VISIBILITY_RECORDING = { public: "repo-visibility-public", private: "repo-visibility-private", unavailable: "repo-visibility-unavailable" } as const;

/** A repository on a host that is not GitHub: `gh repo view` fails for it. Its name in the recording is `UNAVAILABLE_PLACEHOLDER`. */
const UNAVAILABLE_REPO = "https://gitlab.com/gitlab-org/gitlab";
export const UNAVAILABLE_PLACEHOLDER = "https://gitlab.com/owner/repo";

/**
 * What replaces the value of a response header that names the request, the moment or the account the recording was made for (the
 * time, a hash of the profile, when it last changed, the edge that answered, the rate-limit counters). The scopes header keeps what
 * GitHub sent: it is the field the doctor's tests set.
 */
const HEADER_PLACEHOLDERS: Readonly<Record<string, string>> = {
  date: "Thu, 01 Jan 1970 00:00:00 GMT",
  "last-modified": "Thu, 01 Jan 1970 00:00:00 GMT",
  etag: 'W/"0000000000000000000000000000000000000000000000000000000000000000"',
  "x-github-request-id": "0000:000000:0000000:0000000:00000000",
  "x-github-edge-region": "region",
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-reset": "0",
  "x-ratelimit-used": "1",
};

/** `headers` (what `gh api -i` printed) with the value of each header of `HEADER_PLACEHOLDERS` replaced. */
const neutraliseHeaders = (headers: string): string =>
  headers.replace(/^([A-Za-z0-9-]+):.*$/gm, (line, name: string) => (Object.hasOwn(HEADER_PLACEHOLDERS, name.toLowerCase()) ? `${name}: ${HEADER_PLACEHOLDERS[name.toLowerCase()]}` : line));

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

/**
 * The recordings of `gh repo view <url> --json visibility -q .visibility` for `repo` (public) and `privateRepo`, both `owner/name` on
 * GitHub, and for a URL on another host, made through `remoteVisibility`. The two names are replaced by `owner/repo` and the other
 * host's repository by `UNAVAILABLE_PLACEHOLDER`.
 */
export async function recordVisibility(repo: string, privateRepo: string): Promise<Record<string, GhRecording>> {
  const asked = (url: string) => recordCalls(() => remoteVisibility(url, { timeoutMs: 20_000 })).then(([call]) => call!);
  const [publicCall, privateCall, unavailableCall] = [await asked(`https://github.com/${repo}`), await asked(`https://github.com/${privateRepo}`), await asked(UNAVAILABLE_REPO)];
  const scrub = (text: string) => text.split(`https://github.com/${repo}`).join(`https://github.com/${REPO_PLACEHOLDER}`).split(`https://github.com/${privateRepo}`).join(`https://github.com/${REPO_PLACEHOLDER}`).split(UNAVAILABLE_REPO).join(UNAVAILABLE_PLACEHOLDER);
  const recorded = { [VISIBILITY_RECORDING.public]: publicCall, [VISIBILITY_RECORDING.private]: privateCall, [VISIBILITY_RECORDING.unavailable]: unavailableCall };
  const file = Object.fromEntries(Object.entries(recorded).map(([name, r]) => [name, { args: r.args.map(scrub), exitCode: r.exitCode, stdout: scrub(r.stdout), stderr: scrub(r.stderr) }]));
  const text = JSON.stringify(file);
  if (text.includes(repo) || text.includes(privateRepo) || text.includes("gitlab-org")) throw new Error("a visibility recording still names a repository: nothing was written");
  return file;
}

/** The recordings of `gh issue list` for `label` and for a label no issue has, and of the author of the first issue listed (of the cwd's repository, and of `repo` by name and by URL), made in `cwd`, whose origin names the repository. */
export async function record(cwd: string, label: string, repo: string, privateRepo: string): Promise<GhRecordingsFile> {
  const forge = createForge("github", directCommands());
  const listed: Array<{ number: number }> = [];
  const [full, empty] = [
    ...(await recordCalls(async () => listed.push(...(await forge.listIssues(cwd, label))))),
    ...(await recordCalls(() => forge.listIssues(cwd, NO_SUCH_LABEL))),
  ];
  if (listed.length < 2) throw new Error(`${repo} has ${listed.length} open issue(s) labelled ${label}: the recording needs at least two, to show how gh prints a list of them (GH_RECORD_LABEL names another label)`);
  const [author, authorOfRepo, authorOfUrl] = [
    ...(await recordCalls(() => forge.authorStanding(cwd, listed[0]!.number))),
    ...(await recordCalls(() => forge.authorStanding(cwd, listed[0]!.number, repo))),
    ...(await recordCalls(() => forge.authorStanding(cwd, listed[0]!.number, `https://github.com/${repo}`))),
  ];
  const github = loginOf("github", "github.com");
  const [scopes] = await recordCalls(() => readTokenScopes(github.cli, github.token!.scopesArgs, 20_000));
  const scrub = (text: string) => createRedactor({ env: {} }).text(text.split(repo).join(REPO_PLACEHOLDER));
  const version = /^gh version (\S+)/.exec(execFileSync("gh", ["--version"], { encoding: "utf8" }))?.[1] ?? "unknown";
  const file: GhRecordingsFile = {
    recordedWith: { gh: version },
    placeholders: { repo: REPO_PLACEHOLDER },
    recordings: Object.fromEntries(
      [
        ...Object.entries({ "issue-list": full!, "issue-list-empty": empty!, [AUTHOR_RECORDING.cwd]: author!, [AUTHOR_RECORDING.repo]: authorOfRepo!, [AUTHOR_RECORDING.url]: authorOfUrl!, [TOKEN_SCOPES_RECORDING]: scopes! }).map(([name, r]) => [
          name,
          { args: r.args.map(scrub), exitCode: r.exitCode, stdout: scrub(name === TOKEN_SCOPES_RECORDING ? neutraliseHeaders(r.stdout) : r.stdout), stderr: scrub(r.stderr) },
        ]),
        ...Object.entries(await recordVisibility(repo, privateRepo)),
      ],
    ),
  };
  if (repo !== "" && JSON.stringify(file).includes(repo)) throw new Error("a recording still names the repository: nothing was written");
  return file;
}

/** The whole recording; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf("--repo");
  const repo = at === -1 ? execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim() : (argv[at + 1] ?? "");
  const privateAt = argv.indexOf("--private-repo");
  const privateRepo = privateAt === -1 ? (process.env.GH_RECORD_PRIVATE_REPO ?? "") : (argv[privateAt + 1] ?? "");
  if (privateRepo === "") throw new Error("name a private repository of the logged-in account to record how gh prints PRIVATE: --private-repo <owner/name> or GH_RECORD_PRIVATE_REPO (only gh's answer is kept, never the name)");
  const file = await record(process.cwd(), process.env.GH_RECORD_LABEL ?? "ready-for-agent", repo, privateRepo);
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
