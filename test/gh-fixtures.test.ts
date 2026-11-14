// Seam: the repository's own files, read as text the way a reviewer reads them. The recordings of the real `gh` that the dashboard's
// fake `gh` plays (packages/runtime/test/fixtures/gh/recordings.json) are read from disk: they hold no repository of the machine that
// recorded them, no local host and no credential, and they hold what the Backlog's `gh issue list` printed. The GitHub and the gh that
// made them are not here: running them is the recorder's job (scripts/verify/record-gh-fixtures.ts), which stays out of `npm run check` and CI.
// They also hold what `gh api repos/.../issues/<n> --jq .author_association` printed, which the `implement-issue` tests' fake `gh` plays,
// and what `gh api -i --silent user` printed (the response headers, whose scopes header `wf doctor` reads), which the doctor tests' fake `gh` plays.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AUTHOR_RECORDING, type GhRecordingsFile, REPO_PLACEHOLDER, TOKEN_SCOPES_RECORDING } from "../scripts/verify/record-gh-fixtures.js";
import { scopesFromHeaders } from "../packages/runtime/src/github-token-scopes.js";
import { loginOf } from "../packages/runtime/workflows/implement-issue/forge.js";
import { leaksWithoutSecrets } from "../scripts/lib/scrub-recording.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const RECORDINGS = "packages/runtime/test/fixtures/gh/recordings.json";

test("the recordings of gh issue list hold the command line the forge sends, issues, and an empty list for a label no issue has", () => {
  const file = JSON.parse(read(RECORDINGS)) as GhRecordingsFile;
  const listed = file.recordings["issue-list"]!;
  assert.deepEqual(listed.args, ["issue", "list", "--state", "open", "--label=ready-for-agent", "--limit", "100", "--json", "number,title,url"], "forge.ts, listIssues");
  assert.equal(listed.exitCode, 0, listed.stderr);
  const issues = JSON.parse(listed.stdout) as Array<{ number: number; title: string; url: string }>;
  assert.ok(issues.length >= 2, "two issues at least, so the recording shows how gh prints a list of them");
  for (const issue of issues) {
    assert.deepEqual(Object.keys(issue), ["number", "title", "url"]);
    assert.equal(issue.url, `https://github.com/${REPO_PLACEHOLDER}/issues/${issue.number}`);
  }
  assert.ok(listed.stdout.endsWith("]\n"), "compact JSON and a newline, as gh prints it to a pipe");
  assert.equal(file.recordings["issue-list-empty"]!.stdout, "[]\n");
  assert.match(file.recordedWith.gh, /^\d+\.\d+\.\d+$/);
});

test("the recordings of gh api hold the command line the author gate sends, for the cwd's repository, for a named one and for one named by its URL, and what gh prints: one association", () => {
  const file = JSON.parse(read(RECORDINGS)) as GhRecordingsFile;
  const cwd = file.recordings[AUTHOR_RECORDING.cwd]!;
  const named = file.recordings[AUTHOR_RECORDING.repo]!;
  const byUrl = file.recordings[AUTHOR_RECORDING.url]!;
  assert.match(cwd.args.join(" "), /^api --hostname github\.com repos\/\{owner\}\/\{repo\}\/issues\/\d+ --jq \.author_association$/, "forge.ts, authorStanding, without repo: the host of the origin goes in --hostname");
  assert.match(named.args.join(" "), new RegExp(`^api repos/${REPO_PLACEHOLDER}/issues/\\d+ --jq \\.author_association$`), "forge.ts, authorStanding, with repo owner/name: no host to name");
  assert.match(byUrl.args.join(" "), new RegExp(`^api --hostname github\\.com repos/${REPO_PLACEHOLDER}/issues/\\d+ --jq \\.author_association$`), "forge.ts, authorStanding, with repo a URL: its host goes in --hostname");
  for (const recording of [cwd, named, byUrl]) {
    assert.equal(recording.exitCode, 0, recording.stderr);
    assert.match(recording.stdout, /^[A-Z_]+\n$/, "the bare association and a newline: --jq prints a string without quotes");
  }
});

test("the recording of gh api -i --silent user holds the command line the doctor sends, and the headers gh printed: a scopes header, no body, and nothing of the request or the account", () => {
  const file = JSON.parse(read(RECORDINGS)) as GhRecordingsFile;
  const recording = file.recordings[TOKEN_SCOPES_RECORDING]!;
  assert.deepEqual(recording.args, loginOf("github", "github.com").token?.scopesArgs, "forge.ts, loginOf: the arguments the doctor sends");
  assert.equal(recording.exitCode, 0, recording.stderr);
  assert.match(recording.stdout, /^HTTP\/2\.0 200 OK\r?\n/);
  assert.ok(recording.stdout.endsWith("\r\n\r\n"), "the headers and the blank line that ends them: --silent asks for no body, so none of the account's profile is in the file");
  assert.ok((scopesFromHeaders(recording.stdout) ?? []).length > 0, "the doctor's parser finds the scopes in what the real gh printed");
  for (const neutral of [/^Date: Thu, 01 Jan 1970 00:00:00 GMT\r?$/m, /^Last-Modified: Thu, 01 Jan 1970 00:00:00 GMT\r?$/m, /^X-Github-Request-Id: 0000:/m, /^X-Github-Edge-Region: region\r?$/m]) {
    assert.match(recording.stdout, neutral, "the headers that name the moment, the request or the edge are neutralised");
  }
});

test("the recordings name no repository of the machine that recorded them, no local host and no credential", () => {
  const text = read(RECORDINGS);
  assert.deepEqual(leaksWithoutSecrets(text), []);
  const urls = [...text.matchAll(/https:\/\/github\.com\/([^/"]+\/[^/"]+)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  assert.deepEqual([...new Set(urls)], [REPO_PLACEHOLDER], "every address is the placeholder repository's");
});

test("the recorder is not run by npm run check, by any package script or by CI: it needs a login and a real repository", () => {
  const manifests = ["package.json", ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/package.json`)].filter((rel) => existsSync(join(ROOT, rel)));
  const workflows = readdirSync(join(ROOT, ".github", "workflows")).map((name) => `.github/workflows/${name}`);
  for (const rel of [...manifests, ...workflows]) assert.ok(!/record-gh-fixtures/.test(read(rel)), `${rel} must not run the real-GitHub recorder`);
});
