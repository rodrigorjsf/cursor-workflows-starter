// Seam: the forge module in process (`createForge` over a `Commands` whose commands answer with a given stdout): what it makes
// of what `gh` and `glab` printed. The answers are data from a service the kit does not control, and a CLI that changes its
// output, a proxy that answers with an HTML page, or a GitLab of another version would reach `implement-issue`, `wf gc` and the
// dashboard's Backlog as a value they trust. Each read is checked: an answer of the shape the forge gave when it was recorded
// (the real `glab` 1.130.0 output of test/fixtures/glab/recordings.json, and the real `gh` list of test/fixtures/gh/recordings.json)
// is read as before, and any other is an error that names the command and the field, never a TypeError further on. `gh issue view
// --json` has no recording: its two shapes below are written by hand from what gh 2.102.0 printed for this repository's issues. What the workflows do with a forge that fails is asserted by their own
// tests, on the fake `gh` and `glab`.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Commands, type Exec } from "../workflows/implement-issue/commands.js";
import { createForge } from "../workflows/implement-issue/forge.js";
import { GH_RECORDINGS_PATH, type GhRecordingsFile } from "../../../scripts/verify/record-gh-fixtures.js"; // the recorder owns the format and the path; importing it runs nothing
import { recorded } from "./glab-recordings.js";

/** An Exec whose every command exits 0 after printing `stdout`: `Commands.read` has its Exec send a command's stdout to the file named in WF_STDOUT. */
const printing =
  (stdout: string): Exec =>
  async (_command, _args, opts) => {
    writeFileSync(opts?.env?.WF_STDOUT ?? "", stdout);
    return { ok: true, exitCode: 0, timedOut: false, tail: "" };
  };
const LIMITS = { localMs: 1000, networkMs: 1000 };
const github = (stdout: string) => createForge("github", new Commands(printing(stdout), LIMITS));
const gitlab = (stdout: string) => createForge("gitlab", new Commands(printing(stdout), LIMITS));

// --- GitHub -------------------------------------------------------------------------------------------------------------

test("GitHub: an issue as gh prints it is read, and one that is not JSON or has a field of another type is an error naming the command and the field", async () => {
  const printed = JSON.stringify({ number: 7, title: "Add", body: "text", labels: [{ id: "L1", name: "bug", color: "d73a4a" }] });
  assert.deepEqual(await github(printed).issue("/x", 7), { number: 7, title: "Add", body: "text", labels: [{ id: "L1", name: "bug", color: "d73a4a" }] });
  await assert.rejects(github("HTTP 502 Bad Gateway").issue("/x", 7), /^Error: gh issue view 7: not valid JSON \(/);
  await assert.rejects(github(JSON.stringify({ number: "7", title: "Add", body: "text", labels: "bug" })).issue("/x", 7), /^Error: gh issue view 7: number: .*expected number.*; labels: .*expected array/);
  await assert.rejects(github("null").issue("/x", 7), /^Error: gh issue view 7: \(root\): /);
});

test("GitHub: the issues of a label as gh lists them (the recorded output of the real gh) are read, and a list whose issue has no url is an error naming the field", async () => {
  const listed = (JSON.parse(readFileSync(GH_RECORDINGS_PATH, "utf8")) as GhRecordingsFile).recordings["issue-list"];
  assert.ok(listed, `${GH_RECORDINGS_PATH} has no "issue-list" recording: run scripts/verify/record-gh-fixtures.ts`);
  const issues = await github(listed.stdout).listIssues("/x", "ready-for-agent");
  assert.ok(issues.length > 0 && issues.every((i) => Number.isInteger(i.number) && i.url.startsWith("https://")), JSON.stringify(issues));
  assert.deepEqual(await github(JSON.stringify([{ number: 3, title: "a", url: "https://github.com/o/r/issues/3" }])).listIssues("/x", "ready-for-agent"), [{ number: 3, title: "a", url: "https://github.com/o/r/issues/3" }]);
  assert.deepEqual(await github("[]").listIssues("/x", "ready-for-agent"), []);
  await assert.rejects(github(JSON.stringify([{ number: 3, title: "a" }])).listIssues("/x", "ready-for-agent"), /^Error: gh issue list: 0\.url: /);
  await assert.rejects(github('{"message":"Not Found"}').listIssues("/x", "ready-for-agent"), /^Error: gh issue list: \(root\): .*expected array/);
});

test("GitHub: the comments of an issue are read, and a comment whose body is not text is an error naming the field", async () => {
  assert.deepEqual(await github(JSON.stringify({ comments: [{ body: "one", author: { login: "a" } }, { body: "two" }] })).issueComments("/x", 7), ["one", "two"]);
  await assert.rejects(github(JSON.stringify({ comments: [{ body: 5 }] })).issueComments("/x", 7), /^Error: gh issue view 7 comments: comments\.0\.body: /);
  await assert.rejects(github(JSON.stringify({})).issueComments("/x", 7), /^Error: gh issue view 7 comments: comments: /);
});

// --- GitLab -------------------------------------------------------------------------------------------------------------

test("GitLab: the issue glab printed for a real GitLab is read, and an issue with an iid of another type or labels that are not a list is an error naming the field", async () => {
  const printed = recorded("issue-view").stdout;
  const issue = await gitlab(printed).issue("/x", 1);
  assert.equal(issue.number, 1);
  assert.ok(issue.title.length > 0 && Array.isArray(issue.labels));
  const record: Record<string, unknown> = JSON.parse(printed);
  await assert.rejects(gitlab(JSON.stringify({ ...record, iid: "one" })).issue("/x", 1), /^Error: glab issue view 1: iid: .*expected number/);
  await assert.rejects(gitlab(JSON.stringify({ ...record, labels: "bug" })).issue("/x", 1), /^Error: glab issue view 1: labels: .*expected array/);
  await assert.rejects(gitlab("<html>502</html>").issue("/x", 1), /^Error: glab issue view 1: not valid JSON \(/);
  assert.deepEqual(await gitlab(JSON.stringify({ ...record, description: null, labels: undefined })).issue("/x", 1), { number: 1, title: issue.title, body: "", labels: [] }, "no description and no labels are an empty body and none");
});

test("GitLab: the issues glab listed for a real GitLab are read, and a list whose issue has no web_url is an error naming the field", async () => {
  const issues = await gitlab(recorded("issue-list").stdout).listIssues("/x", "ready-for-agent");
  assert.ok(issues.length > 0 && issues.every((i) => Number.isInteger(i.number) && i.url.startsWith("http")), JSON.stringify(issues));
  assert.deepEqual(await gitlab(recorded("issue-list-empty").stdout).listIssues("/x", "none"), []);
  await assert.rejects(gitlab(JSON.stringify([{ iid: 1, title: "a" }])).listIssues("/x", "ready-for-agent"), /^Error: glab issue list: 0\.web_url: /);
});

test("GitLab: the notes of an issue are read from one page or from several, without GitLab's own system notes, and a note whose body is not text is an error", async () => {
  const one = await gitlab(recorded("issue-notes").stdout).issueComments("/x", 1);
  assert.ok(one.length > 0 && one.every((body) => typeof body === "string"));
  const many = await gitlab(recorded("issue-notes-two-pages").stdout).issueComments("/x", 2);
  assert.ok(many.length > one.length, "every page is read");
  assert.deepEqual(await gitlab(JSON.stringify([{ body: "mine" }, { body: "added label", system: true }])).issueComments("/x", 1), ["mine"]);
  await assert.rejects(gitlab(JSON.stringify([{ body: 5 }])).issueComments("/x", 1), /^Error: glab api issue notes: 0\.0\.body: /);
  await assert.rejects(gitlab('{"message":"404 Not Found"}').issueComments("/x", 1), /^Error: glab api issue notes: expected a list/);
});

test("GitLab: the project glab printed is read for its URL, and one with no web_url is an error naming the field", async () => {
  assert.match(await gitlab(recorded("repo-view").stdout).repoUrl("/x"), /^https?:\/\//);
  await assert.rejects(gitlab(JSON.stringify({ id: 3 })).repoUrl("/x"), /^Error: glab api project: web_url: /);
});

test("GitLab: the merge requests of a branch are read, and one with no state or no web_url is an error naming the field; a list of another shape is the error it was", async () => {
  const mr = await gitlab(recorded("mr-list").stdout).prUrl("/x", "wf/issue-1-recorded");
  assert.match(mr ?? "", /^https?:\/\/.*merge_requests\/\d+/);
  assert.equal(await gitlab(recorded("mr-list-empty").stdout).prUrl("/x", "none"), undefined);
  await assert.rejects(gitlab(JSON.stringify([{ state: "opened" }])).prUrl("/x", "b"), /^Error: glab api merge_requests \(b\): 0\.0\.web_url: /);
  await assert.rejects(gitlab(JSON.stringify([{ web_url: "https://x/-/merge_requests/1" }])).prState("/x", "b"), /^Error: glab api merge_requests \(b\): 0\.0\.state: /);
  await assert.rejects(gitlab('{"message":"401 Unauthorized"}').prUrl("/x", "b"), /^Error: glab api merge_requests \(b\): expected a list/);
});
