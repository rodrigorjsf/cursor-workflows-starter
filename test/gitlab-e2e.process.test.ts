// Seam: the process. `scripts/verify/gitlab-e2e.sh` is run the way a maintainer runs it, with stand-ins on the PATH for what it drives:
// a `docker` that logs every call and answers from environment variables (no GitLab is started: that takes minutes and 2.5 GB), a
// `curl` that says the sign-in page answers, a `glab` that prints a version, and an `npx` that stands for the recorder and logs what the
// script handed it. The tests read the exit code, what the script printed, the calls the stand-ins logged and the files left behind;
// none of them looks inside the script. What a real GitLab and a real glab do is the script's own run, which is opt-in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "verify", "gitlab-e2e.sh");
const DEFAULT_IMAGE = "gitlab/gitlab-ce:19.5.5-ce.0";
/** What the script may ask of Docker: start, ask, run in, and remove what it started. Nothing that restarts or configures it. */
const DOCKER_COMMANDS = new Set(["info", "ps", "run", "inspect", "exec", "rm", "volume"]);

let sandbox: string;
let counter = 0;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-gitlab-e2e-test-"));
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

// One line per call, though one argument (the GitLab settings) spans several.
const DOCKER = `line=$(printf '%s' "docker $*" | tr '\\n' ' ')
printf '%s\\n' "$line" >> "$FAKE_LOG"
case "$1" in
  info)
    [ -n "$FAKE_DOCKER_DOWN" ] && exit 1
    case "$*" in *MemTotal*) echo "\${FAKE_DOCKER_MEMORY:-8328593408}" ;; esac ;;
  ps) [ -n "$FAKE_EXISTING_CONTAINER" ] && echo abc123def456 ;;
  volume) [ "$2" != inspect ] || [ -n "$FAKE_EXISTING_VOLUME" ] || exit 1 ;;
  inspect) echo "\${FAKE_HEALTH:-starting}" ;;
  exec)
    case "$*" in
      *awk*) echo "fake-root-password" ;;
      *gitlab-rails*) echo "WF_E2E_TOKEN=glpat-fake-token-0123" ;;
    esac ;;
esac
exit 0`;

const GLAB = `echo "glab \${FAKE_GLAB_VERSION:-1.130.0} (0000000)"`;

/** The recorder's stand-in: logs the environment the script gave it, and fails when told to. */
const NPX = `printf '%s\\n' "npx $*" >> "$FAKE_LOG"
printf '%s\\n' "recorder url=$GITLAB_E2E_URL token=$GITLAB_E2E_TOKEN password=$GITLAB_E2E_PASSWORD image=$GITLAB_E2E_IMAGE scratch=$GITLAB_E2E_SCRATCH" >> "$FAKE_LOG"
[ -d "$GITLAB_E2E_SCRATCH" ] || exit 3
[ -z "$FAKE_RECORDER_FAILS" ] || exit 1
exit 0`;

function bin(dir: string, name: string, script: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, name), 0o755);
}

/** One run of the script: its own PATH of stand-ins and its own log. */
function runScript(extraEnv: Record<string, string> = {}, args: string[] = []) {
  const dir = join(sandbox, `run-${++counter}`);
  const fakes = join(dir, "fakes");
  const log = join(dir, "calls.log");
  mkdirSync(dir);
  writeFileSync(log, "");
  bin(fakes, "docker", DOCKER);
  bin(fakes, "curl", "exit 0");
  bin(fakes, "glab", GLAB);
  bin(fakes, "npx", NPX);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: [fakes, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: dir,
      TMPDIR: dir,
      FAKE_LOG: log,
      // No waiting between polls, and none for GitLab: the stand-in's health says "starting" until a test says otherwise.
      GITLAB_E2E_TIMEOUT_SECONDS: "0",
      GITLAB_E2E_POLL_SECONDS: "1",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { status: r.status, out: r.stdout + r.stderr, stderr: r.stderr, calls, docker: calls.filter((c) => c.startsWith("docker ")), dir };
}

const READY = { FAKE_HEALTH: "healthy", GITLAB_E2E_TIMEOUT_SECONDS: "60" };

test("the script starts the pinned GitLab CE image by default, and the image in GITLAB_E2E_IMAGE when one is given", () => {
  const byDefault = runScript();
  assert.ok(byDefault.docker.some((c) => c.startsWith("docker run ") && c.endsWith(` ${DEFAULT_IMAGE}`)), byDefault.docker.join("\n"));

  const other = runScript({ GITLAB_E2E_IMAGE: "gitlab/gitlab-ce:latest" });
  const run = other.docker.find((c) => c.startsWith("docker run "))!;
  assert.ok(run.endsWith(" gitlab/gitlab-ce:latest"), run);
  assert.ok(!run.includes(DEFAULT_IMAGE), "the override replaces the default");
});

test("the container runs with memory-constrained settings: one Puma process, a lean Sidekiq, no Prometheus, a larger shared memory", () => {
  const run = runScript().docker.find((c) => c.startsWith("docker run "))!;
  assert.match(run, /--shm-size 256m/);
  assert.match(run, /puma\['worker_processes'\] = 0/);
  assert.match(run, /sidekiq\['concurrency'\] = 5/);
  assert.match(run, /prometheus_monitoring\['enable'\] = false/);
  assert.match(run, /--publish 127\.0\.0\.1:8929:8929/, "GitLab is published on the loopback interface only");
});

test("the container and its volumes are removed when GitLab never gets ready", () => {
  const r = runScript();
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^error: GitLab was not ready/m);
  assert.ok(r.docker.includes("docker rm -f -v wf-gitlab-e2e"), r.docker.join("\n"));
  assert.ok(r.docker.includes("docker volume rm -f wf-gitlab-e2e-config wf-gitlab-e2e-logs wf-gitlab-e2e-data"), r.docker.join("\n"));
});

test("the recorder gets the URL, the token, the root password, the image and a scratch directory, and the container and volumes are removed after it", () => {
  const r = runScript({ ...READY, GITLAB_E2E_IMAGE: "gitlab/gitlab-ce:latest" });
  assert.equal(r.status, 0, r.out);
  const recorder = r.calls.find((c) => c.startsWith("recorder "))!;
  assert.match(recorder, /url=http:\/\/localhost:8929 token=glpat-fake-token-0123 password=fake-root-password image=gitlab\/gitlab-ce:latest scratch=\//);
  assert.ok(r.calls.includes("npx tsx scripts/verify/record-glab-fixtures.ts"));
  const order = (call: string) => r.calls.findIndex((c) => c === call);
  assert.ok(order("docker rm -f -v wf-gitlab-e2e") > order("npx tsx scripts/verify/record-glab-fixtures.ts"), "the container goes after the recording");
  assert.ok(r.docker.includes("docker volume rm -f wf-gitlab-e2e-config wf-gitlab-e2e-logs wf-gitlab-e2e-data"));
  const scratch = /scratch=(\S+)/.exec(recorder)![1]!;
  assert.equal(existsSync(scratch), false, "the scratch directory is removed");
});

test("the container and its volumes are removed when the recorder fails, and the script says it failed", () => {
  const r = runScript({ ...READY, FAKE_RECORDER_FAILS: "1" });
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.docker.includes("docker rm -f -v wf-gitlab-e2e"), r.docker.join("\n"));
  assert.ok(r.docker.includes("docker volume rm -f wf-gitlab-e2e-config wf-gitlab-e2e-logs wf-gitlab-e2e-data"));
});

test("a container the script did not start is never removed: a name already in use stops it before anything is started", () => {
  const r = runScript({ FAKE_EXISTING_CONTAINER: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^error: a container named wf-gitlab-e2e exists/m);
  assert.deepEqual(r.docker.filter((c) => /^docker (run|rm|volume)/.test(c)), [], "no container was started and nothing was removed");
});

test("a volume the script did not make is never removed: a name already in use by a volume stops it before anything is started", () => {
  const r = runScript({ FAKE_EXISTING_VOLUME: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^error: a volume named wf-gitlab-e2e-config exists/m);
  assert.deepEqual(r.docker.filter((c) => /^docker (run|rm|volume rm)/.test(c)), [], "nothing was started and nothing was removed");
});

test("a name and a port of the maintainer's choosing name the container, its volumes and the published port", () => {
  const r = runScript({ GITLAB_E2E_NAME: "wf-gitlab-e2e-mine", GITLAB_E2E_PORT: "9090" });
  const run = r.docker.find((c) => c.startsWith("docker run "))!;
  assert.match(run, /--name wf-gitlab-e2e-mine /);
  assert.match(run, /--publish 127\.0\.0\.1:9090:9090/);
  assert.match(run, /external_url 'http:\/\/localhost:9090'/);
  assert.ok(r.docker.includes("docker volume rm -f wf-gitlab-e2e-mine-config wf-gitlab-e2e-mine-logs wf-gitlab-e2e-mine-data"));
});

test("Docker is never restarted or reconfigured: the script only starts, asks, runs in and removes what it started", () => {
  for (const env of [{}, READY, { ...READY, FAKE_RECORDER_FAILS: "1" }, { FAKE_EXISTING_CONTAINER: "1" }, { FAKE_EXISTING_VOLUME: "1" }]) {
    const { docker } = runScript(env);
    for (const call of docker) {
      assert.ok(DOCKER_COMMANDS.has(call.split(" ")[1]!), `an unexpected docker command: ${call}`);
      assert.ok(!/^docker volume (?!rm -f wf-gitlab-e2e-config wf-gitlab-e2e-logs wf-gitlab-e2e-data$|inspect wf-gitlab-e2e-(config|logs|data)$)/.test(call), `a volume command other than asking about, and removing, its own three: ${call}`);
    }
  }
});

test("a glab other than the one mise.toml pins is refused before Docker is touched", () => {
  const r = runScript({ FAKE_GLAB_VERSION: "1.99.0" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^error: glab on the PATH is "glab 1\.99\.0 .*", mise\.toml pins 1\.130\.0/m);
  assert.deepEqual(r.docker, []);
});

test("a Docker with too little memory for GitLab is refused, naming the setting that lowers the bar", () => {
  const r = runScript({ FAKE_DOCKER_MEMORY: String(2 * 1024 * 1024 * 1024) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^error: Docker has 2048 MiB, GitLab CE needs at least 4096 \(GITLAB_E2E_MIN_MEMORY_MB\)/m);
  assert.deepEqual(r.docker.filter((c) => c.startsWith("docker run")), []);
});

test("a Docker daemon that does not answer is not started by the script", () => {
  const r = runScript({ FAKE_DOCKER_DOWN: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^error: the Docker daemon does not answer: start Docker yourself/m);
  assert.deepEqual(r.docker.filter((c) => c.startsWith("docker run")), []);
});

test("an argument it does not know is a usage error, and --help prints the usage and starts nothing", () => {
  const unknown = runScript({}, ["--nope"]);
  assert.equal(unknown.status, 2, unknown.out);
  assert.match(unknown.stderr, /^usage: gitlab-e2e\.sh/m);
  const help = runScript({}, ["--help"]);
  assert.equal(help.status, 0, help.out);
  assert.deepEqual(help.docker, []);
});
