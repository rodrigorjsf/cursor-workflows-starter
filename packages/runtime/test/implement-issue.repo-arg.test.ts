// Seam: the workflow's `repo` argument, through `runWorkflow` with the fake Cursor SDK and the fake `gh` and `glab`. The forge's CLI
// sends its token to the host the `--repo` it is given names (`gh` takes `[HOST/]OWNER/REPO` and a URL, and sends GH_ENTERPRISE_TOKEN,
// or the login stored for that host, to a host other than github.com), so a `repo` chosen by whoever drove the chat must not pick that
// host. `repo` names its own host only when that host is the forge's default, the host of this repository's `origin`, or one the config
// lists in `workflows.implement-issue.settings.repoHosts`: anything else ends the run before the first forge call. What each case
// asserts is what the fake CLIs were asked (nothing), not how the refusal is worded inside.
import assert from "node:assert/strict";
import { test } from "node:test";
import { repoHostOf } from "../workflows/implement-issue/repo-arg.js";
import { writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";
import { forgeState, forgeTest, fx, issue, names, run, setOrigin } from "./implement-issue.fixture.js";

const res = (r: { result?: unknown }) => r.result as any;
const settings = (value: Record<string, unknown>) => writeRepoConfig(fx.repo, { workflows: { "implement-issue": { settings: value } } });
const forgeCalls = () => forgeState().calls;

/** Runs with `repo` and asserts the run ended before any forge call and any agent step, with a reason that names `mentions`. */
async function refused(repo: string, mentions: RegExp) {
  const [forgeBefore, stepsBefore] = [forgeCalls(), names()];
  const r = await run({ repo });
  assert.equal(r.status, "failed", `${repo}: ${JSON.stringify(r.result)}`);
  assert.match(r.error ?? "", mentions, repo);
  assert.deepEqual(forgeCalls(), forgeBefore, `${repo}: the forge's CLI was called`);
  assert.deepEqual(names(), stepsBefore, `${repo}: an agent step ran`);
}

forgeTest("a repo that names a host other than github.com, in any spelling gh takes, is refused before any gh call, and so is one with a plain-text scheme", async () => {
  issue(["complexity:medium"]);
  await refused("example.invalid/o/r", /example\.invalid.*repoHosts/s); // HOST/OWNER/REPO: gh sends its token to that host
  await refused("ghe/o/r", /\bghe\b.*repoHosts/s); // gh takes the first of three segments as the host, dot or not
  await refused("https://evil.example/o/r", /evil\.example/); // a host that is no known forge: refused by the forge detection
  await refused("ssh://git@evil.example/o/r", /evil\.example/);
  await refused("git@evil.example:o/r.git", /evil\.example/);
  await refused("http://github.com/o/r", /https|ssh|plain-text/); // github.com, but in the clear
  await refused("git://github.com/o/r", /https|ssh|plain-text/);
  await refused("ext::touch", /\bext\b/); // a remote helper is not a repository
  await refused("https://evil.example:99999/o/r", /not a valid URL/); // Node's URL parser refuses the port: the spelling must not count as "names no host"
}, ["github"]);

forgeTest("a repo that is not made of owner/name characters is refused by the arguments' schema, before the run starts", async () => {
  issue(["complexity:medium"]);
  for (const repo of ["-o/r", "a b/c", "o/r?x=1", "o/r;ls", "$(id)/r", "", "/o/r", "..", ".x/y"]) {
    const r = await run({ repo });
    assert.equal(r.status, "failed", repo);
    assert.equal(r.refused, true, `${JSON.stringify(repo)}: the arguments were refused, the run never started`);
    assert.match(r.error ?? "", /invalid args: data\/repo must match pattern/, repo);
  }
  assert.deepEqual(forgeCalls(), []);
}, ["github"]);

forgeTest("owner/name, github.com in every spelling, and the forge's own host keep working", async () => {
  for (const repo of ["acme/b", "github.com/acme/b", "https://github.com/acme/b", "https://GitHub.com/acme/b.git", "git@github.com:acme/b.git", "ssh://git@github.com/acme/b"]) {
    issue(["complexity:medium"]);
    const r = await run({ repo });
    assert.equal(res(r).status, "seams-proposed", `${repo}: ${JSON.stringify(r)}`);
    assert.ok(forgeCalls().some((c) => c[0] === "issue" && c[1] === "view"), `${repo}: the issue was read`);
  }
}, ["github"]);

forgeTest("a host listed in repoHosts of the repository's config is allowed, whatever its case, and an entry that names a port allows that port only", async () => {
  settings({ repoHosts: ["GHE.corp.example"] });
  issue(["complexity:medium"]);
  const listed = await run({ repo: "ghe.corp.example/acme/b" });
  assert.equal(res(listed).status, "seams-proposed", JSON.stringify(listed));

  writeRepoConfig(fx.repo, {});
  writeGlobalConfig({ workflows: { "implement-issue": { settings: { repoHosts: ["other.corp.example:9443"] } } } });
  await refused("other.corp.example/acme/b", /other\.corp\.example.*repoHosts/s); // the entry names a port: the bare host is not the same destination
}, ["github"]);

forgeTest("the host of this repository's own origin is allowed with no setting: a run there sends the token to that host anyway", async () => {
  setOrigin("https://ghe.corp.example/owner/repo.git");
  writeRepoConfig(fx.repo, { forges: { "ghe.corp.example": "github" } });
  issue(["complexity:medium"]);
  const r = await run({ repo: "ghe.corp.example/acme/b" });
  assert.equal(res(r).status, "seams-proposed", JSON.stringify(r));
  await refused("ghe2.corp.example/acme/b", /ghe2\.corp\.example.*repoHosts/s); // another host of the same company is another destination
}, ["github"]);

forgeTest("a host the config declares under forges is allowed, in the spelling a URL has and in the one gh takes", async () => {
  writeRepoConfig(fx.repo, { forges: { "ghe.corp.example": "github" } });
  for (const repo of ["https://ghe.corp.example/acme/b", "ghe.corp.example/acme/b"]) {
    issue(["complexity:medium"]);
    const r = await run({ repo });
    assert.equal(res(r).status, "seams-proposed", `${repo}: ${JSON.stringify(r)}`);
  }
  await refused("ghe2.corp.example/acme/b", /ghe2\.corp\.example/); // a host the config does not name stays refused
}, ["github"]);

forgeTest("on GitLab, group/sub/project is a path and keeps working, gitlab.com is the default host, and a dotted first segment is a host to allow", async () => {
  for (const repo of ["group/sub/project", "group/project", "gitlab.com/group/project", "https://gitlab.com/group/sub/project"]) {
    issue(["complexity:medium"]);
    const r = await run({ repo });
    assert.equal(res(r).status, "seams-proposed", `${repo}: ${JSON.stringify(r)}`);
  }
  const before = forgeCalls().length;
  const r = await run({ repo: "gitlab.example.com/group/project" });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /gitlab\.example\.com.*repoHosts/s);
  assert.equal(forgeCalls().length, before, "the refused run made no glab call");

  settings({ repoHosts: ["gitlab.example.com"] });
  issue(["complexity:medium"]);
  const listed = await run({ repo: "gitlab.example.com/group/project" });
  assert.equal(res(listed).status, "seams-proposed", JSON.stringify(listed));
}, ["gitlab"]);

// glab 1.130.0 (`glrepo.FromFullName`) takes the last segment of a scheme-less value as the repository and splits the rest at its first
// slash, whatever the segment count: that first part is a host only when it has a `.` or a `:` (and is a host glab is logged in to), else
// the whole prefix is a nested group on the default host. The kit cannot read glab's logins, so every dotted or colon first segment of three
// or more segments counts as a host, and a plain nested group of any depth names none.
forgeTest("on GitLab a nested group of any depth is a path and keeps working, with no repoHosts", async () => {
  for (const repo of ["group/sub/deeper/project", "g/s/n/m/p", "https://gitlab.com/group/sub/deeper/project"]) {
    issue(["complexity:medium"]);
    const r = await run({ repo });
    assert.equal(res(r).status, "seams-proposed", `${repo}: ${JSON.stringify(r)}`);
  }
}, ["gitlab"]);

forgeTest("on GitLab a dotted first segment is still a host at four segments or more, so it is refused until that name is allowed", async () => {
  issue(["complexity:medium"]);
  await refused("evil.example/g/s/p", /evil\.example.*repoHosts/s);
  await refused("evil.example/g/s/n/p", /evil\.example.*repoHosts/s);
  await refused("host:3000/g/p", /\bhost\b/); // a port: the kit reads it as an scp-like remote, which names its host (refused by the forge detection)
  await refused("https://evil.example:99999/group/project", /not a valid URL/);

  settings({ repoHosts: ["evil.example"] });
  issue(["complexity:medium"]);
  const listed = await run({ repo: "evil.example/g/s/p" });
  assert.equal(res(listed).status, "seams-proposed", JSON.stringify(listed));
}, ["gitlab"]);

// The host `repoHostOf` finds in a scheme-less `repo`, on the forge each CLI reads it for: what `repoRefusal` then checks against the policy.
test("repoHostOf: on GitLab only a dotted or colon first segment of three segments or more is a host, whatever the depth", () => {
  for (const repo of ["g/p", "g/s/p", "g/s/n/p", "g/s/n/m/p", "group/sub/deeper/project/x", "Corp/g/s/p"]) assert.equal(repoHostOf(repo, "gitlab"), undefined, repo);
  assert.equal(repoHostOf("h.x/g/p", "gitlab"), "h.x");
  assert.equal(repoHostOf("H.X/g/s/p", "gitlab"), "h.x", "in lower case");
  assert.equal(repoHostOf("h.x/g/s/n/p", "gitlab"), "h.x");
  assert.equal(repoHostOf("h.x/p", "gitlab"), undefined, "two segments are OWNER/REPO whatever the owner looks like");
  assert.equal(repoHostOf("host:3000/g/p", "gitlab"), "host", "a port is read as an scp-like remote, which names its host");
  assert.notEqual(repoHostOf("h:/g/p", "gitlab"), undefined, "a colon in the first segment never passes as a path, whatever else reads it");
  assert.equal(repoHostOf("https://evil.example/g/s/n/p", "gitlab"), "evil.example", "a URL names its host");
});

test("repoHostOf: on GitHub the first of three segments is a host, dot or not, and two segments are OWNER/REPO", () => {
  assert.equal(repoHostOf("o/r", "github"), undefined);
  assert.equal(repoHostOf("ghe/o/r", "github"), "ghe");
  assert.equal(repoHostOf("GHE.corp.example/o/r", "github"), "ghe.corp.example");
  assert.equal(repoHostOf("https://github.com/o/r", "github"), "github.com");
});
