// Seam: what a cloud step sends off the machine about the repository. `cloudRepoUrl` is called directly; the cloud backend
// is called the way the engine calls it, with the fake Cursor SDK and a temporary bare repository that git reaches through
// `url.<bare>.insteadOf`, so the remote can be configured as any URL while the push still lands locally.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, resetCloud, script } from "@cursor/sdk";
import type { StepOptions } from "../src/runtime/backend.js";
import { createCloudBackend } from "../src/runtime/backend-cloud.js";
import { cloudRepoUrl } from "../src/runtime/cloud-snapshot.js";
import { createRedactor } from "../src/runtime/redaction.js";
import { git, remoteBranches, repoWithRemote } from "./cloud-fixtures.js";

const FAKE_SECRET = "FAKEpass" + "1234567";
let root = "";
let repo = "";
let bare = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-cloud-remote-"));
  repo = join(root, "repo");
  bare = join(root, "origin.git");
  repoWithRemote(repo, bare);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  resetCloud();
});

/** Configures `origin` as `url`, with git sending it to the bare repository all the same. */
function remoteIs(url: string) {
  git(repo, "remote", "set-url", "origin", url);
  git(repo, "config", `url.${bare}.insteadOf`, url);
}

const options: StepOptions = { name: "wf:step", model: { id: "m" }, cwd: repo, settingSources: [], sandbox: false, writes: false, schemaRetries: 2, tools: ["read"] };
const attempt = () => createCloudBackend({ remote: "origin", runId: "run-1" }).run("p", { ...options, cwd: repo }, new AbortController().signal, () => {});

test("the repository URL a cloud agent gets never carries the credentials of the remote URL", () => {
  for (const [remoteUrl, url] of [
    [`https://alice:${FAKE_SECRET}@github.com/org/repo.git`, "https://github.com/org/repo"],
    [`https://${FAKE_SECRET}@github.com/org/repo`, "https://github.com/org/repo"],
    [`https://x-access-token:${FAKE_SECRET}@git.example.com:8443/org/repo.git`, "https://git.example.com:8443/org/repo"],
    [`ssh://git:${FAKE_SECRET}@github.com/org/repo.git`, "https://github.com/org/repo"],
    ["git@github.com:org/repo.git", "https://github.com/org/repo"],
  ] as const) {
    assert.equal(cloudRepoUrl(remoteUrl), url, remoteUrl);
  }
});

test("the repository URL a cloud agent gets drops the query and the fragment of the remote URL", () => {
  for (const [remoteUrl, url] of [
    [`https://github.com/org/repo.git?token=${FAKE_SECRET}`, "https://github.com/org/repo"],
    [`https://github.com/org/repo#${FAKE_SECRET}`, "https://github.com/org/repo"],
    [`https://github.com/org/repo/?a=1#b`, "https://github.com/org/repo"],
    [`ssh://git@github.com/org/repo.git?x=${FAKE_SECRET}`, "https://github.com/org/repo"],
    [`git@github.com:org/repo.git#${FAKE_SECRET}`, "https://github.com/org/repo"],
  ] as const) {
    assert.equal(cloudRepoUrl(remoteUrl), url, remoteUrl);
  }
});

test("an ssh remote on an IPv6 host is a host, not a remote helper", () => {
  for (const [remoteUrl, url] of [
    ["git@[2001:db8::1]:org/repo.git", "https://[2001:db8::1]/org/repo"],
    ["ssh://[2001:db8::1]:22/org/repo.git", "https://[2001:db8::1]/org/repo"],
    ["ssh://git@[2001:db8::1]/org/repo", "https://[2001:db8::1]/org/repo"],
  ] as const) {
    assert.equal(cloudRepoUrl(remoteUrl), url, remoteUrl);
  }
});

test("a remote that is not https or ssh on a host is refused with a message that says why", () => {
  for (const remoteUrl of ["http://github.com/org/repo.git", "git://github.com/org/repo.git", "file:///srv/git/repo.git", "ext::sh -c x", "/srv/git/origin.git", "../origin.git", "https:///org/repo"]) {
    assert.throws(() => cloudRepoUrl(remoteUrl), /cloud step.*https:\/\/ or ssh/, remoteUrl);
  }
});

test("a cloud step whose remote URL holds credentials sends the agent the URL without them", async () => {
  remoteIs(`https://alice:${FAKE_SECRET}@example.invalid/org/repo.git`);
  const result = await attempt();
  assert.equal(result.outcome.kind, "finished", JSON.stringify(result.outcome));
  assert.equal(calls[0].cloud.repos[0].url, "https://example.invalid/org/repo");
  assert.ok(!JSON.stringify(calls).includes(FAKE_SECRET));
});

test("a cloud step on a remote named by a url.<base>.insteadOf alias sends the agent the URL the alias stands for", async () => {
  git(repo, "remote", "set-url", "origin", "gh:org/repo.git");
  git(repo, "config", "url.https://example.invalid/.insteadOf", "gh:");
  git(repo, "config", "remote.origin.pushurl", bare); // the push still lands in the bare repository
  const result = await attempt();
  assert.equal(result.outcome.kind, "finished", JSON.stringify(result.outcome));
  assert.equal(calls[0].cloud.repos[0].url, "https://example.invalid/org/repo");
});

for (const refused of ["http://example.invalid/org/repo.git", "git://example.invalid/org/repo.git"]) {
  test(`a cloud step on a ${refused.split(":")[0]}:// remote fails at once, before the snapshot leaves the machine`, async () => {
    remoteIs(refused);
    const result = await attempt();
    assert.equal(result.outcome.kind, "error");
    assert.match((result.outcome as { message: string }).message, /https:\/\/ or ssh/);
    assert.equal(result.final, true, "another attempt would be refused the same way");
    assert.deepEqual(remoteBranches(bare), [], "nothing was pushed");
    assert.equal(calls.length, 0, "no agent was created");
  });
}

test("the redactor hides the password of a URL and keeps the rest of it", () => {
  const { text } = createRedactor({ env: {} });
  assert.equal(text(`fatal: unable to access 'https://alice:${FAKE_SECRET}@example.invalid/org/repo.git/'`), "fatal: unable to access 'https://alice:[REDACTED]@example.invalid/org/repo.git/'");
  assert.equal(text("see https://example.com/a:b@c and user@example.com"), "see https://example.com/a:b@c and user@example.com");
});

test("the redactor hides a URL's userinfo that is a token alone, and keeps a short user name", () => {
  const { text } = createRedactor({ env: {} });
  assert.equal(text("fatal: could not read from 'https://tok123456789012345@gitlab.com/x'"), "fatal: could not read from 'https://[REDACTED]@gitlab.com/x'");
  assert.equal(text("ssh://git@github.com/org/repo and https://alice@example.com/x"), "ssh://git@github.com/org/repo and https://alice@example.com/x");
});
