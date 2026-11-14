// Seam: the repository's own files, read as text the way a reviewer reads them, plus the recorder's scrubbing as a function. The
// recordings of the real `glab` that the fake `glab` plays (packages/runtime/test/fixtures/glab/recordings.json) are read from disk:
// they hold no token, password or local host, they were made with the glab that mise.toml pins, and every recording the offline
// tests rely on is there with the shape they read. The opt-in script and its recorder stay out of `npm run check` and CI. The
// GitLab and the glab that made the recordings are not here: running them is the script's job (scripts/verify/gitlab-e2e.sh).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { type Recording, type RecordingsFile, scrubRecordings } from "../scripts/verify/record-glab-fixtures.js";
import { AVATAR_PLACEHOLDER, HOST_PLACEHOLDER, PASSWORD_PLACEHOLDER, SCRATCH_PLACEHOLDER, TOKEN_PLACEHOLDER, leaksIn, leaksWithoutSecrets, scrubText } from "../scripts/lib/scrub-recording.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const RECORDINGS = "packages/runtime/test/fixtures/glab/recordings.json";

/** The pinned version of `tool` in mise.toml, or undefined. */
const pinnedIn = (toml: string, tool: string): string | undefined => new RegExp(`^${tool}\\s*=\\s*"([^"]+)"`, "m").exec(toml)?.[1];

const SECRETS = { token: "glpat-s3cr3t-token-value", password: "hunter2-root-password", scratch: "/tmp/wf-gitlab-e2e-AbC123", home: "/home/maintainer" };

// ── the scrubbing ────────────────────────────────────────────────────────────────────────────────────────────────

test("the token, the root password, the local host and the machine's paths are replaced by fixed placeholders", () => {
  const raw = [
    `Authorization: Bearer ${SECRETS.token}`,
    `password=${SECRETS.password}`,
    "web_url http://localhost:8929/owner/repo/-/merge_requests/1 and https://localhost/x",
    "ssh_url git@localhost:owner/repo.git and ssh://git@127.0.0.1:2424/owner/repo.git",
    `config at ${SECRETS.scratch}/glab-config/config.yml and ${SECRETS.home}/.config`,
    "avatar https://www.gravatar.com/avatar/74c8f92c19079e44d84d21d3c0e7cf7d74c8f92c19079e44d84d21d3c0e7cf7d?s=80&d=identicon",
  ].join("\n");
  const scrubbed = scrubText(raw, SECRETS);
  assert.equal(
    scrubbed,
    [
      `Authorization: Bearer ${TOKEN_PLACEHOLDER}`,
      `password=${PASSWORD_PLACEHOLDER}`,
      `web_url http://${HOST_PLACEHOLDER}/owner/repo/-/merge_requests/1 and https://${HOST_PLACEHOLDER}/x`,
      `ssh_url git@${HOST_PLACEHOLDER}:owner/repo.git and ssh://git@${HOST_PLACEHOLDER}/owner/repo.git`,
      `config at ${SCRATCH_PLACEHOLDER}/glab-config/config.yml and /home/user/.config`,
      `avatar ${AVATAR_PLACEHOLDER}?s=80&d=identicon`,
    ].join("\n"),
  );
  assert.deepEqual(leaksIn(scrubbed, SECRETS), [], "what is left is clean");
});

test("leaksIn finds what a scrubbed text still holds: the token, the password, a local host, a path of this machine, and a token it was not told about", () => {
  assert.deepEqual(leaksIn(`t ${SECRETS.token}`, SECRETS), ["the token"]);
  assert.deepEqual(leaksIn(`p ${SECRETS.password}`, SECRETS), ["the root password"]);
  assert.deepEqual(leaksIn(`s ${SECRETS.scratch}/x h ${SECRETS.home}`, SECRETS), ["the scratch directory", "the home directory"]);
  assert.deepEqual(leaksIn("http://localhost:8929/x", SECRETS), ["a local host"]);
  assert.match(leaksIn(`an unknown glpat-${"a1B2c3D4e5".repeat(2)} token`, SECRETS)[0] ?? "", /^a credential: GitLab token/);
  assert.match(leaksIn(`"runners_token":"GR1348941${"a1B2c3D4e5".repeat(2)}"`, SECRETS)[0] ?? "", /^a credential: GitLab runner registration token/);
  assert.deepEqual(leaksIn(`only the placeholder ${TOKEN_PLACEHOLDER} and ${HOST_PLACEHOLDER}`, SECRETS), []);
  assert.deepEqual(leaksWithoutSecrets("http://127.0.0.1:8929/x"), ["a local host"], "a committed fixture is checked without knowing the run's secrets");
});

test("the recorder scrubs every stream of every recording, and writes nothing when the file still holds a secret after that", () => {
  const unknownToken = `glpat-${"a1B2c3D4e5".repeat(2)}`;
  const file: RecordingsFile = {
    recordedWith: { glab: "1.130.0", gitlab: "19.5.5", image: "gitlab/gitlab-ce:19.5.5-ce.0" },
    placeholders: { host: HOST_PLACEHOLDER },
    subjects: { project: "owner/repo", issue: 1, branch: "wf/issue-1-recorded", title: "Recorded", mr: 1 },
    recordings: {
      "issue-view": {
        args: ["issue", "view", "1", "--hostname", "localhost:8929"],
        exitCode: 0,
        stdout: `{"web_url":"http://localhost:8929/x","token":"${SECRETS.token}","runners_token":"GR1348941${"a1B2c3D4e5".repeat(2)}"}\n`,
        stderr: `warning: ${unknownToken} and ${SECRETS.password} at ${SECRETS.scratch}\n`,
      },
    },
  };
  const scrubbed = scrubRecordings(file, SECRETS).recordings["issue-view"]!;
  assert.deepEqual(scrubbed.args, ["issue", "view", "1", "--hostname", HOST_PLACEHOLDER]);
  assert.equal(scrubbed.stdout, `{"web_url":"http://${HOST_PLACEHOLDER}/x","token":"${TOKEN_PLACEHOLDER}","runners_token":"[REDACTED]"}\n`);
  assert.equal(scrubbed.stderr, `warning: [REDACTED] and ${PASSWORD_PLACEHOLDER} at ${SCRATCH_PLACEHOLDER}\n`);

  // What the scrubbing does not touch (the subjects and the versions are the recorder's own words) is still checked.
  file.subjects.title = `a title that holds ${unknownToken}`;
  assert.throws(() => scrubRecordings(file, SECRETS), /the recording file still holds a credential: GitLab token.*: nothing was written/);
});

// ── the committed recordings ─────────────────────────────────────────────────────────────────────────────────────

test("the recordings hold no token, password, local host or machine path: fixed placeholders stand in their place", () => {
  const text = read(RECORDINGS);
  assert.deepEqual(leaksWithoutSecrets(text), []);
  assert.ok(!text.includes(homedir()), "the home directory of whoever recorded them");
  assert.ok(!/PRIVATE-TOKEN|Authorization:|initial_root_password|Password:/i.test(text), "no header or file that carries a credential");
  assert.ok(text.includes(HOST_PLACEHOLDER), "the placeholder host is there: the recordings were scrubbed, not made without a host");
});

test("the recordings were made with the glab that mise.toml pins, and that version is pinned exactly", () => {
  const pinned = pinnedIn(read("mise.toml"), "glab");
  assert.equal(pinned, "1.130.0");
  const file = JSON.parse(read(RECORDINGS)) as RecordingsFile;
  assert.equal(file.recordedWith.glab, pinned, "bumping glab in mise.toml means recording again: scripts/verify/gitlab-e2e.sh");
});

test("every recording the fake glab plays is there, with the shape the offline tests read", () => {
  const { recordings, subjects } = JSON.parse(read(RECORDINGS)) as RecordingsFile;
  const json = (name: string): any => JSON.parse(recordings[name]!.stdout);
  for (const name of ["issue-view", "issue-notes", "issue-notes-two-pages", "note-create", "mr-create", "mr-list", "mr-list-empty", "repo-view", "auth-status-logged-in", "auth-status-logged-out"]) {
    assert.ok(recordings[name], `a recording named ${name}`);
  }
  assert.equal(json("issue-view").iid, subjects.issue);
  assert.ok(Array.isArray(json("issue-view").labels) && json("issue-view").labels.every((l: unknown) => typeof l === "string"), "labels are plain names");
  const notes = json("issue-notes") as Array<{ system: boolean }>;
  assert.ok(notes.some((n) => n.system) && notes.some((n) => !n.system), "a system note and a comment, as GitLab lists an issue that a merge request mentions");
  assert.equal((json("issue-notes-two-pages") as unknown[]).length, 25, "glab --paginate joins the pages into one array");
  assert.deepEqual(json("mr-list-empty"), []);
  const [mr] = json("mr-list");
  assert.equal(mr.iid, subjects.mr);
  assert.equal(mr.source_branch, subjects.branch);
  assert.equal(mr.state, "opened");
  assert.match(recordings["mr-create"]!.stdout, new RegExp(`/-/merge_requests/${subjects.mr}\\n`));
  assert.equal(recordings["auth-status-logged-in"]!.exitCode, 0);
  assert.notEqual(recordings["auth-status-logged-out"]!.exitCode, 0);
  assert.match(json("repo-view").path_with_namespace, /^[^/]+\/[^/]+$/);
});

test("the dashboard's merge request by URL and the forge's calls with a repo argument were recorded from the real glab too", () => {
  const { recordings, subjects } = JSON.parse(read(RECORDINGS)) as RecordingsFile;
  const ran = (name: string): Recording => {
    const recording = recordings[name];
    assert.ok(recording, `a recording named ${name}`);
    assert.equal(recording.exitCode, 0, `${name} succeeded on the real GitLab: ${recording.stderr}`);
    return recording;
  };
  const named = `http://${HOST_PLACEHOLDER}/${subjects.project}`;

  // What the dashboard's PR-state source runs (packages/runtime/src/runtime/pr-by-url.ts), from no checkout.
  const byUrl = ran("mr-api");
  // The recorded GitLab has a port, which glab's --hostname refuses: the host goes in GITLAB_HOST (packages/runtime/src/runtime/glab-host.ts).
  assert.deepEqual(byUrl.args, ["api", `projects/${encodeURIComponent(subjects.project)}/merge_requests/${subjects.mr}`]);
  assert.deepEqual(byUrl.env, { GITLAB_HOST: HOST_PLACEHOLDER });
  const mr = JSON.parse(byUrl.stdout);
  assert.equal(mr.iid, subjects.mr);
  assert.equal(mr.state, "opened");

  // The forge module with a `repo` argument: `--repo <url>` for glab's own commands, the host and the project's path for `glab api`.
  const issue = ran("issue-view-repo");
  assert.deepEqual(issue.args.slice(0, 5), ["issue", "view", String(subjects.issue), "--repo", named]);
  assert.equal(JSON.parse(issue.stdout).iid, subjects.issue);
  const project = ran("repo-view-repo");
  assert.deepEqual(project.args, ["api", `projects/${encodeURIComponent(subjects.project)}`]);
  assert.deepEqual(project.env, { GITLAB_HOST: HOST_PLACEHOLDER });
  assert.equal(JSON.parse(project.stdout).path_with_namespace, subjects.project);
  const created = ran("mr-create-repo");
  assert.deepEqual(created.args.slice(-2), ["--repo", named]);
  assert.match(created.stdout, /\/-\/merge_requests\/\d+\n/);

  // A host with no port (gitlab.com, most self-managed hosts) goes in `glab api --hostname <host>`, the form the dashboard and the
  // cross-repository forge calls take there: the real glab accepted it too, with no GITLAB_HOST.
  const byHostname = ran("mr-api-hostname");
  assert.deepEqual(byHostname.args, ["api", "--hostname", HOST_PLACEHOLDER, `projects/${encodeURIComponent(subjects.project)}/merge_requests/${subjects.mr}`]);
  assert.equal(byHostname.env, undefined);
  assert.equal(JSON.parse(byHostname.stdout).state, "opened");
  const projectByHostname = ran("repo-view-hostname");
  assert.deepEqual(projectByHostname.args, ["api", "--hostname", HOST_PLACEHOLDER, `projects/${encodeURIComponent(subjects.project)}`]);
  assert.equal(projectByHostname.env, undefined);
  assert.equal(JSON.parse(projectByHostname.stdout).path_with_namespace, subjects.project);
});

// ── the script stays out of the checks ───────────────────────────────────────────────────────────────────────────

test("the opt-in script, its recorder and its prover are not run by npm run check, by any package script or by CI", () => {
  const manifests = ["package.json", ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/package.json`)].filter((rel) => existsSync(join(ROOT, rel)));
  const workflows = readdirSync(join(ROOT, ".github", "workflows")).map((name) => `.github/workflows/${name}`);
  for (const rel of [...manifests, ...workflows]) {
    assert.ok(!/gitlab-e2e|record-glab-fixtures|prove-gitlab/.test(read(rel)), `${rel} must not run the real-GitLab script: it needs Docker and minutes, and the prover spends tokens`);
  }
});

test("every environment variable a maintainer can set for the real-GitLab scripts is named in the usage line, the header of the script, the README and the book", () => {
  const scripts = ["scripts/verify/gitlab-e2e.sh", "scripts/verify/prove-gitlab.ts", "scripts/verify/record-glab-fixtures.ts"];
  // The script sets these for the scripts it runs: a maintainer never does.
  const setByTheScript = new Set(["GITLAB_E2E_URL", "GITLAB_E2E_TOKEN", "GITLAB_E2E_PASSWORD", "GITLAB_E2E_SCRATCH"]);
  const named = new Set(scripts.flatMap((rel) => read(rel).match(/GITLAB_E2E_[A-Z_]+/g) ?? []));
  const settable = [...named].filter((name) => !setByTheScript.has(name));
  assert.ok(settable.length >= 9, `the variables found: ${settable.join(", ")}`);

  const script = read("scripts/verify/gitlab-e2e.sh");
  const usage = script.split("\n").find((line) => line.includes('echo "usage:')) ?? "";
  const header = script.split("\n").filter((line, i) => i === 0 || line.startsWith("#")).join("\n");
  const readme = read("scripts/verify/README.md");
  const book = read("docs/contributing/04-scripts-do-mantenedor.md");
  for (const name of settable) {
    assert.ok(usage.includes(name), `${name} is missing from the usage line of scripts/verify/gitlab-e2e.sh`);
    assert.ok(header.includes(name), `${name} is missing from the HOW header of scripts/verify/gitlab-e2e.sh`);
    assert.ok(readme.includes(name), `${name} is missing from scripts/verify/README.md`);
    assert.ok(book.includes(name), `${name} is missing from docs/contributing/04-scripts-do-mantenedor.md`);
  }
});
