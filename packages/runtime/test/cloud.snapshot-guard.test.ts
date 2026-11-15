// Seam: `pushSnapshot`, the engine's door to a remote for a cloud step, called the way the cloud backend calls it, with real git, a
// temporary repository and a temporary bare repository as its remote. The `gh` it asks about the remote's visibility is a stand-in
// on the PATH that plays the recording of the real one (fake-gh-visibility.ts). A snapshot that differs from HEAD holds the
// worktree's uncommitted and untracked files, and deleting its branch afterwards does not unpublish them: so it is scanned for secrets
// and its remote is checked for being public before anything is pushed, and the tests read the bare remote to see that nothing was.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SnapshotRefusedError, pushSnapshot, snapshotBranch } from "../src/runtime/cloud-snapshot.js";
import { git, remoteBranches, repoWithRemote } from "./cloud-fixtures.js";
import { type VisibilityAnswer, fakeVisibilityGh } from "./fake-gh-visibility.js";

let root = "";
let repo = "";
let remote = "";
let gh: ReturnType<typeof fakeVisibilityGh> | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-snapshot-guard-"));
  repo = join(root, "repo");
  remote = join(root, "origin.git");
  repoWithRemote(repo, remote);
});
afterEach(() => {
  gh?.restore();
  gh = undefined;
  rmSync(root, { recursive: true, force: true });
});

const x = (n: number) => "x".repeat(n);
const answering = (answer: VisibilityAnswer) => (gh = fakeVisibilityGh(root, answer));
/** The refs the bare remote has under the snapshot prefix, as `git ls-remote` shows them. */
const snapshotRefs = () => git(remote, "for-each-ref", "refs/heads/wf/cloud-snapshot/").trim();
const push = (extra: { allowPublicRemote?: boolean } = {}) => pushSnapshot({ cwd: repo, remote: "origin", branch: snapshotBranch("run-1"), ...extra });
/** What `push` rejects with: the refusal, whose message must name the rule and never the secret. */
async function refused(extra?: { allowPublicRemote?: boolean }): Promise<SnapshotRefusedError> {
  try {
    await push(extra);
  } catch (err) {
    assert.ok(err instanceof SnapshotRefusedError, `not a refusal: ${err}`);
    return err;
  }
  throw new Error("the snapshot was pushed");
}

// ── Secrets ─────────────────────────────────────────────────────────────────────────────

test("an untracked .env, auth.json or a file with a token in it makes the snapshot refuse, and nothing reaches the remote", async () => {
  answering("PRIVATE");
  const token = `ghp_${x(36)}`;
  for (const [file, content, rule] of [
    [".env", "A=1\n", /a \.env file/],
    [".env.local", "A=1\n", /a \.env file/],
    ["config/auth.json", "{}\n", /auth\.json file/],
    ["notes.txt", `the token is ${token}\n`, /GitHub token/],
  ] as const) {
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, file), content);
    const refusal = await refused();
    assert.match(refusal.message, rule, file);
    assert.ok(!refusal.message.includes(token), "the message names the rule, never the secret");
    assert.equal(snapshotRefs(), "", `${file}: a snapshot ref reached the remote`);
    assert.equal(git(remote, "ls-remote", ".", "refs/heads/wf/cloud-snapshot/*").trim(), "");
    rmSync(join(repo, file));
  }
});

test("a secret added to a tracked file is found too, and one already committed is not the snapshot's to report", async () => {
  answering("PRIVATE");
  writeFileSync(join(repo, "b.txt"), `b\ntoken = ghp_${x(36)}\n`);
  assert.match((await refused()).message, /GitHub token/);
  assert.equal(snapshotRefs(), "");

  git(repo, "checkout", "--", "b.txt");
  writeFileSync(join(repo, "c.txt"), `already committed: ghp_${x(36)}\n`);
  git(repo, "add", "c.txt");
  git(repo, "commit", "-qm", "later");
  writeFileSync(join(repo, "a.txt"), "a, edited\n");
  await push(); // the secret is in HEAD, which the user has: the change the snapshot adds has none
  assert.notEqual(snapshotRefs(), "");
});

test("the saved Cursor key, found in a file of the worktree, makes the snapshot refuse", async () => {
  answering("PRIVATE");
  const saved = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = `saved-key-${x(24)}`;
  try {
    writeFileSync(join(repo, "leak.txt"), `key: ${process.env.CURSOR_API_KEY}\n`);
    assert.match((await refused()).message, /the saved SDK key or CURSOR_API_KEY/);
  } finally {
    if (saved === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = saved;
  }
  assert.equal(snapshotRefs(), "");
});

// ── The remote's visibility ─────────────────────────────────────────────────────────────

test("a snapshot that differs from HEAD is not pushed to a public remote: it refuses, says why and names the opt-in", async () => {
  const asked = answering("PUBLIC");
  writeFileSync(join(repo, "a.txt"), "a, edited\n");
  const refusal = await refused();
  assert.match(refusal.message, /is public/);
  assert.match(refusal.message, /does not unpublish/);
  assert.match(refusal.message, /cloud\.allowPublicRemote/);
  assert.equal(snapshotRefs(), "");
  assert.deepEqual(asked.asked(), [["repo", "view", "https://example.invalid/origin/repo", "--json", "visibility", "-q", ".visibility"]], "the repository the agent is given is the one asked about");
});

test("a private remote gets the snapshot", async () => {
  answering("PRIVATE");
  writeFileSync(join(repo, "a.txt"), "a, edited\n");
  const snapshot = await push();
  assert.equal(git(remote, "rev-parse", snapshot.branch).trim(), snapshot.commit);
});

test("when gh cannot answer (another host, no network, no login) the snapshot is refused the same way, naming the opt-in and what gh said", async () => {
  answering("unavailable");
  writeFileSync(join(repo, "a.txt"), "a, edited\n");
  const refusal = await refused();
  assert.match(refusal.message, /could not tell whether/);
  assert.match(refusal.message, /GraphQL: Field 'repository' doesn't exist/, "gh's own words");
  assert.match(refusal.message, /cloud\.allowPublicRemote/);
  assert.equal(snapshotRefs(), "");
});

test("a snapshot that is HEAD itself is pushed without asking anyone: it holds nothing the user has not committed", async () => {
  const asked = answering("unavailable");
  const snapshot = await push();
  assert.equal(snapshot.commit, git(repo, "rev-parse", "HEAD").trim());
  assert.deepEqual(asked.asked(), []);
});

test("allowPublicRemote pushes to a public remote, and to one gh cannot answer for, without asking gh", async () => {
  for (const answer of ["PUBLIC", "unavailable"] as const) {
    const asked = answering(answer);
    writeFileSync(join(repo, "a.txt"), `a, edited for ${answer}\n`);
    const snapshot = await push({ allowPublicRemote: true });
    assert.equal(git(remote, "rev-parse", snapshot.branch).trim(), snapshot.commit, answer);
    assert.deepEqual(asked.asked(), [], "the owner said it does not matter: gh is not asked");
    gh!.restore();
  }
});

test("allowPublicRemote does not skip the secret scan", async () => {
  answering("PUBLIC");
  writeFileSync(join(repo, ".env"), "A=1\n");
  assert.match((await refused({ allowPublicRemote: true })).message, /a \.env file/);
  assert.equal(snapshotRefs(), "");
});

test("the remote's branches are untouched by a refused snapshot, whichever rule refused it", async () => {
  answering("PUBLIC");
  writeFileSync(join(repo, "a.txt"), "a, edited\n");
  await refused();
  writeFileSync(join(repo, ".env"), "A=1\n");
  await refused({ allowPublicRemote: true });
  assert.deepEqual(remoteBranches(remote), []);
});
