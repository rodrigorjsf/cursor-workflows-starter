// Seam: the process. The `wf` CLI and the MCP server are spawned (against the fake Cursor SDK) in a temporary repo with
// a temporary home. Covers `wf config show`, and `start_workflow`: tighten-only overrides, the config re-read on every
// call, and an unusable config refused up front with the field path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { readEventLog, eventLogPath } from "../src/runtime/run-store.js";
import { writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";
import { forgeState, fx, issue, setup, teardown } from "./implement-issue.fixture.js";

const PACKAGE = join(import.meta.dirname, "..");
let sandbox: string;
let home: string;
let repo: string;

const globalConfig = () => join(home, "config.json");
const repoConfig = () => join(repo, ".agents", "workflows", "config.json");
const put = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-config-process-"));
  home = join(sandbox, "home");
  repo = join(sandbox, "repo");
  mkdirSync(home);
  // A workflow with two roles that finishes without calling an agent: only the config is under test.
  put(
    join(repo, ".agents", "workflows", "cfgwf.mjs"),
    `export default {
  meta: { name: "cfgwf", description: "config test", roles: [
    { name: "classify", cloud: "ok", defaults: { model: { id: "composer-2.5" } } },
    { name: "review", cloud: "read-only", defaults: { model: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] } } },
  ] },
  defaults: { model: { id: "m" } },
  budget: { maxTokens: 3000000 },
  async run() { return "done"; },
};\n`,
  );
  put(
    join(repo, ".agents", "workflows", "echoargs.mjs"),
    `export default {
  meta: { name: "echoargs", description: "returns its args" },
  defaults: { model: { id: "m" } },
  budget: { maxTokens: 3000000 },
  async run(ctx) { return ctx.args; },
};\n`,
  );
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

const childEnv = () => ({ ...getDefaultEnvironment(), WF_HOME: home, TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json"), WF_METRICS: "off", WF_DASH_AUTOSTART: "off", WF_CWD: repo });
const tsxArgs = (script: string) => ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", script)];

function wf(...args: string[]) {
  const r = spawnSync(process.execPath, [...tsxArgs("cli.ts"), ...args, "--cwd", repo], { env: childEnv(), encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("wf config show prints each workflow's effective config, the provenance of its values and the violations", () => {
  put(globalConfig(), { caps: { maxTokens: 1_000_000 } });
  put(repoConfig(), { workflows: { cfgwf: { maxTokens: 2_000_000, roles: { review: { retries: 0 } } } } });
  const r = wf("config", "show", "cfgwf");
  assert.equal(r.status, 0, r.stderr);
  const shown = JSON.parse(r.stdout);
  assert.deepEqual(shown.files, { global: { path: globalConfig(), found: true }, repo: { path: repoConfig(), found: true } });
  assert.deepEqual(Object.keys(shown.workflows), ["cfgwf"]);
  const { config, provenance, violations } = shown.workflows.cfgwf;
  assert.equal(config.limits.maxTokens, 1_000_000);
  assert.deepEqual(provenance["/limits/maxTokens"], { layer: "cap", ref: globalConfig() });
  assert.equal(config.roles.review.retries, 0);
  assert.deepEqual(provenance["/roles/review/retries"], { layer: "repo", ref: repoConfig() });
  assert.equal(config.roles.review.model.id, "grok-4.7");
  assert.deepEqual(violations.map((v: { path: string }) => v.path), ["/workflows/cfgwf/maxTokens"]);
});

test("wf config show without a workflow name covers every workflow of the repo, built-ins included; flags are the top layer", () => {
  rmSync(globalConfig(), { force: true });
  rmSync(repoConfig(), { force: true });
  const r = wf("config", "show", "--max-tokens", "123456");
  assert.equal(r.status, 0, r.stderr);
  const shown = JSON.parse(r.stdout);
  assert.ok("cfgwf" in shown.workflows && "implement-issue" in shown.workflows, Object.keys(shown.workflows).join());
  assert.equal(shown.workflows.cfgwf.config.limits.maxTokens, 123456);
  assert.deepEqual(shown.workflows.cfgwf.provenance["/limits/maxTokens"], { layer: "flag", ref: "--max-tokens" });
  assert.deepEqual(shown.files, { global: { path: globalConfig(), found: false }, repo: { path: repoConfig(), found: false } });
});

test("wf config show prints the settings of a workflow with the repo file's values and their origin; a setting the workflow does not declare exits 1", () => {
  put(repoConfig(), { workflows: { "implement-issue": { settings: { fixRounds: 1, labelTiers: { urgent: "HIGH" } } } } });
  const r = wf("config", "show", "implement-issue");
  assert.equal(r.status, 0, r.stderr);
  const { config, provenance } = JSON.parse(r.stdout).workflows["implement-issue"];
  assert.equal(config.settings.fixRounds, 1);
  assert.deepEqual(config.settings.labelTiers, { urgent: "HIGH" }, "the file's map replaces the default one");
  assert.deepEqual(config.settings.sliceCaps, { LOW: 1, MED: 3, HIGH: 5 });
  assert.deepEqual(provenance["/settings/fixRounds"], { layer: "repo", ref: repoConfig() });
  assert.deepEqual(provenance["/settings/sliceCaps"], { layer: "default" });

  put(repoConfig(), { workflows: { cfgwf: { settings: { fixRounds: 1 } } } });
  const bad = wf("config", "show", "cfgwf");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\/workflows\/cfgwf\/settings\/fixRounds: unknown setting \(workflow cfgwf declares no settings\)/);
  rmSync(repoConfig(), { force: true });
});

test("wf config show prints the effective forges, host by host, with the file each host comes from, the same for every workflow", () => {
  put(globalConfig(), { forges: { "git.example.com": "gitlab", "ghe.corp.example": "github" } });
  put(repoConfig(), { forges: { "git.example.com": "github", "code.other.example:8443": "gitlab" } });
  const r = wf("config", "show", "--max-tokens", "123456");
  assert.equal(r.status, 0, r.stderr);
  const { workflows } = JSON.parse(r.stdout);
  for (const name of ["cfgwf", "implement-issue"]) {
    const { config, provenance } = workflows[name];
    assert.deepEqual(config.forges, { "git.example.com": "github", "ghe.corp.example": "github", "code.other.example:8443": "gitlab" }, name);
    assert.deepEqual(provenance["/forges/git.example.com"], { layer: "repo", ref: repoConfig() }, name);
    assert.deepEqual(provenance["/forges/ghe.corp.example"], { layer: "global", ref: globalConfig() }, name);
    assert.deepEqual(provenance["/forges/code.other.example:8443"], { layer: "repo", ref: repoConfig() }, name);
  }
  rmSync(globalConfig(), { force: true });
  rmSync(repoConfig(), { force: true });
  const none = JSON.parse(wf("config", "show", "cfgwf").stdout).workflows.cfgwf;
  assert.deepEqual(none.config.forges, {});
});

test("wf config show with an unusable config exits 1 and names the file and the field path; an unknown workflow is named", () => {
  put(repoConfig(), { workflows: { cfgwf: { roles: { review: { retries: -1 } } } } });
  const bad = wf("config", "show", "cfgwf");
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes(repoConfig()), bad.stderr);
  assert.ok(bad.stderr.includes("/workflows/cfgwf/roles/review/retries"), bad.stderr);

  rmSync(repoConfig(), { force: true });
  const unknown = wf("config", "show", "nope");
  assert.equal(unknown.status, 1);
  assert.ok(unknown.stderr.includes("unknown workflow: nope. Use `wf list`."), unknown.stderr); // the MCP server's wording
});

async function withServer<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "config-process-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: tsxArgs("mcp-server.ts"), cwd: repo, env: childEnv() }));
    return await use(client);
  } finally {
    await client.close();
  }
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) as Record<string, any> };
};

/** Starts the workflow, waits for the end, and returns what the run recorded in run-start. */
async function startAndRead(client: Client, args: Record<string, unknown> = {}) {
  const started = await call(client, "start_workflow", { name: "cfgwf", ...args });
  assert.equal(started.isError, false, JSON.stringify(started.body));
  let state = started.body;
  for (let i = 0; i < 30 && state.status !== "finished" && state.status !== "failed"; i++) {
    state = (await call(client, "wait_workflow", { jobId: started.body.jobId, timeoutSec: 5 })).body;
  }
  assert.equal(state.status, "finished", JSON.stringify(state));
  const events: WorkflowEvent[] = readEventLog(eventLogPath(repo, started.body.runId)).events;
  return { started: started.body, start: events.find((e): e is Extract<WorkflowEvent, { type: "run-start" }> => e.type === "run-start")! };
}

test("start_workflow reads the config afresh on every call, without restarting the server", async () => {
  rmSync(globalConfig(), { force: true });
  rmSync(repoConfig(), { force: true });
  await withServer(async (client) => {
    const first = await startAndRead(client);
    assert.equal(first.start.config.limits.maxCents, null);
    put(repoConfig(), { workflows: { cfgwf: { maxCents: 42 } } });
    const second = await startAndRead(client);
    assert.equal(second.start.config.limits.maxCents, 42);
    assert.deepEqual(second.start.provenance["/limits/maxCents"], { layer: "repo", ref: repoConfig() });
  });
});

test("start_workflow takes tighten-only overrides; a looser one is reported in the reply and has no effect", async () => {
  put(globalConfig(), { caps: { maxCents: 500 } });
  put(repoConfig(), { workflows: { cfgwf: { maxCents: 300 } } });
  await withServer(async (client) => {
    const tight = await startAndRead(client, { overrides: { maxTokens: 400_000, maxCents: 100 } });
    assert.equal(tight.start.config.limits.maxTokens, 400_000);
    assert.equal(tight.start.config.limits.maxCents, 100);
    assert.deepEqual(tight.start.provenance["/limits/maxCents"], { layer: "mcp", ref: "start_workflow.overrides" });
    assert.equal(tight.started.violations, undefined, "nothing to report");

    const loose = await startAndRead(client, { overrides: { maxCents: 450, concurrency: 2 } });
    assert.equal(loose.start.config.limits.maxCents, 300, "450 would loosen the repo's 300");
    assert.equal(loose.start.config.limits.concurrency, 2);
    assert.equal(loose.started.violations.length, 1);
    assert.equal(loose.started.violations[0].layer, "mcp");
    assert.equal(loose.started.violations[0].path, "maxCents");
    assert.equal(loose.start.violations.length, 1, "the run records it too");
  });
});

test("start_workflow refuses an override that is not a valid limit, before a job exists", async () => {
  rmSync(repoConfig(), { force: true });
  await withServer(async (client) => {
    const zero = await call(client, "start_workflow", { name: "cfgwf", overrides: { concurrency: 0 } });
    assert.equal(zero.isError, true);
    assert.match(zero.body.error, /start_workflow\.overrides.*concurrency/);
    const fraction = await call(client, "start_workflow", { name: "cfgwf", overrides: { maxTokens: 1.5 } });
    assert.equal(fraction.isError, true);
    assert.equal(fraction.body.jobId, undefined);
  });
});

test("start_workflow refuses an unusable config up front, with the file and the field path, and starts no job", async () => {
  put(repoConfig(), { workflows: { cfgwf: { roles: { clasify: {} } } } });
  await withServer(async (client) => {
    const r = await call(client, "start_workflow", { name: "cfgwf" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /\/workflows\/cfgwf\/roles\/clasify: unknown role/);
    assert.ok(String(r.body.error).includes(repoConfig()));
    assert.equal(r.body.jobId, undefined);
  });
  rmSync(repoConfig(), { force: true });
});

test("list_workflows publishes the roles a workflow declares: the contract of its config keys", async () => {
  await withServer(async (client) => {
    const listed = await client.callTool({ name: "list_workflows", arguments: {} });
    const metas = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text) as Array<{ name: string; roles?: Array<{ name: string; cloud: string }> }>;
    assert.deepEqual(metas.find((m) => m.name === "cfgwf")!.roles!.map((r) => `${r.name}:${r.cloud}`), ["classify:ok", "review:read-only"]);
  });
});

test("wf start refuses an unusable config in the parent, before it spawns anything", () => {
  put(repoConfig(), { workflows: { cfgwf: { concurrency: 0 } } });
  const r = wf("start", "cfgwf");
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("/workflows/cfgwf/concurrency"), r.stderr);
  assert.equal(r.stdout, "", "no job was created");
  rmSync(repoConfig(), { force: true });
});

const IMPLEMENT_ISSUE_SETTINGS = "workflows.implement-issue.settings";
const fileOf = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const settingsFile = (settings: Record<string, unknown>) => ({ workflows: { "implement-issue": { settings } } });
const clearConfig = () => {
  rmSync(globalConfig(), { force: true });
  rmSync(repoConfig(), { force: true });
};
const shownForImplementIssue = () => {
  const r = wf("config", "show", "implement-issue");
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).workflows["implement-issue"] as { config: { settings: Record<string, unknown> }; provenance: Record<string, unknown> };
};
const jobCount = () => (existsSync(join(repo, ".workflows", "jobs")) ? readdirSync(join(repo, ".workflows", "jobs")).length : 0);

test("wf config show names the layer each delivery setting came from: the code default, the global file, the repo file over it", () => {
  clearConfig();
  const delivery = () => {
    const { config, provenance } = shownForImplementIssue();
    return { values: { worktree: config.settings.worktree, openPr: config.settings.openPr }, worktree: provenance["/settings/worktree"], openPr: provenance["/settings/openPr"] };
  };
  assert.deepEqual(delivery(), { values: { worktree: false, openPr: true }, worktree: { layer: "default" }, openPr: { layer: "default" } });

  put(globalConfig(), settingsFile({ worktree: true, openPr: false }));
  assert.deepEqual(delivery(), {
    values: { worktree: true, openPr: false },
    worktree: { layer: "global", ref: globalConfig() },
    openPr: { layer: "global", ref: globalConfig() },
  });

  put(repoConfig(), settingsFile({ openPr: true }));
  assert.deepEqual(delivery(), {
    values: { worktree: true, openPr: true },
    worktree: { layer: "global", ref: globalConfig() },
    openPr: { layer: "repo", ref: repoConfig() },
  });
  clearConfig();
});

test("wf config set writes the global file by default, and wf config show then names that file as the layer", () => {
  clearConfig();
  const r = wf("config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.openPr`, "false");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { file: globalConfig(), scope: "global", path: `${IMPLEMENT_ISSUE_SETTINGS}.openPr`, value: false });
  assert.deepEqual(fileOf(globalConfig()), settingsFile({ openPr: false }));
  assert.equal(existsSync(repoConfig()), false);
  const { config, provenance } = shownForImplementIssue();
  assert.equal(config.settings.openPr, false);
  assert.deepEqual(provenance["/settings/openPr"], { layer: "global", ref: globalConfig() });
  clearConfig();
});

const DELIVERY_DOCS = ["INSTALL-AGENT.md", join("skills", "cursor-workflows-setup", "SKILL.md")];

test("every wf config set command the install guide and the setup skill give for the delivery defaults is accepted and writes the setting it names", () => {
  clearConfig();
  const commands = new Set(
    DELIVERY_DOCS.flatMap((doc) => {
      const section = readFileSync(join(PACKAGE, "..", "..", doc), "utf8").split(/^## /m).find((part) => /^(?:\d+\. )?Choose the delivery defaults/.test(part)) ?? "";
      return [...section.matchAll(/wf config set [^`\n]+/g)].map((match) => match[0].trim());
    }),
  );
  assert.equal(commands.size, 6, `the four global and the two --repo commands: ${[...commands].join(" | ")}`);
  for (const command of commands) {
    const words = command.split(" ").slice(1);
    const [path, value] = words.filter((word) => word !== "--repo").slice(2);
    const r = wf(...words);
    assert.equal(r.status, 0, `${command}: ${r.stderr}`);
    const written = fileOf(words.includes("--repo") ? repoConfig() : globalConfig());
    assert.equal(written.workflows["implement-issue"].settings[path!.split(".").pop()!], JSON.parse(value!), command);
  }
  clearConfig();
});

test("wf config set --repo writes the repo file, keeps what the file already holds and leaves the global file alone", () => {
  clearConfig();
  put(globalConfig(), { caps: { maxCents: 100 } });
  const globalBefore = readFileSync(globalConfig(), "utf8");
  put(repoConfig(), { kit: ">=0.4.0 <0.5.0", workflows: { "implement-issue": { settings: { fixRounds: 1 } } } });
  const r = wf("config", "set", "--repo", `${IMPLEMENT_ISSUE_SETTINGS}.worktree`, "true");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).file, repoConfig());
  assert.deepEqual(fileOf(repoConfig()), { kit: ">=0.4.0 <0.5.0", workflows: { "implement-issue": { settings: { fixRounds: 1, worktree: true } } } });
  assert.equal(readFileSync(globalConfig(), "utf8"), globalBefore);
  assert.deepEqual(shownForImplementIssue().provenance["/settings/worktree"], { layer: "repo", ref: repoConfig() });
  clearConfig();
});

test("wf config set takes a JSON value as JSON, and any other text as a string; a name with a dot is written with a backslash", () => {
  clearConfig();
  assert.equal(wf("config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.backlogLabel`, "triaged").status, 0);
  assert.equal(wf("config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.contextFiles`, '["docs/a.md","docs/adr"]').status, 0);
  assert.equal(wf("config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.sliceCaps`, '{"LOW":2,"MED":3,"HIGH":5}').status, 0);
  assert.equal(wf("config", "set", "workflows.implement-issue.roles.implement\\.low.retries", "0").status, 0);
  assert.deepEqual(fileOf(globalConfig()), {
    workflows: {
      "implement-issue": {
        settings: { backlogLabel: "triaged", contextFiles: ["docs/a.md", "docs/adr"], sliceCaps: { LOW: 2, MED: 3, HIGH: 5 } },
        roles: { "implement.low": { retries: 0 } },
      },
    },
  });
  clearConfig();
});

test("wf config set refuses a value the schema rejects, with the schema error, and the file is not touched", () => {
  clearConfig();
  const path = `${IMPLEMENT_ISSUE_SETTINGS}.openPr`;
  const missing = wf("config", "set", path, '"yes"');
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.ok(missing.stderr.includes(globalConfig()), missing.stderr);
  assert.match(missing.stderr, /\/workflows\/implement-issue\/settings\/openPr: must be boolean/);
  assert.equal(existsSync(globalConfig()), false, "no file was made");

  put(globalConfig(), settingsFile({ fixRounds: 1 }));
  const before = readFileSync(globalConfig(), "utf8");
  const present = wf("config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.redGreenAttempts`, "0");
  assert.equal(present.status, 1);
  assert.match(present.stderr, /\/workflows\/implement-issue\/settings\/redGreenAttempts/);
  assert.equal(readFileSync(globalConfig(), "utf8"), before, "the file holds the same bytes");
  clearConfig();
});

test("wf config set refuses an unknown path: a key the schema does not know, and a setting the workflow does not declare", () => {
  clearConfig();
  const unknownKey = wf("config", "set", "nonsense", "1");
  assert.equal(unknownKey.status, 1);
  assert.match(unknownKey.stderr, /\/nonsense: unknown key/);
  const unknownSection = wf("config", "set", "workflows.implement-issue.nope.x", "1");
  assert.equal(unknownSection.status, 1);
  assert.match(unknownSection.stderr, /\/workflows\/implement-issue\/nope: unknown key/);
  const typo = wf("config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.openPrr`, "false");
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /\/workflows\/implement-issue\/settings\/openPrr: unknown setting \(workflow implement-issue declares: .*worktree, openPr\)/);
  assert.equal(existsSync(globalConfig()), false);
  assert.equal(existsSync(repoConfig()), false);
});

test("wf config set refuses a path below a value that is not an object, a file that is not JSON, and a path that is not dotted names", () => {
  clearConfig();
  put(repoConfig(), { kit: ">=0.4.0 <0.5.0" });
  const below = wf("config", "set", "--repo", "kit.minor", "1");
  assert.equal(below.status, 1);
  assert.match(below.stderr, /\/kit: is not an object/);

  put(globalConfig(), "{ not json");
  const broken = wf("config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.openPr`, "false");
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /invalid JSON/);
  assert.equal(readFileSync(globalConfig(), "utf8"), "{ not json");

  const empty = wf("config", "set", "workflows..settings", "1");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /is not a dotted path/);
  clearConfig();
});

test("wf config set without a path and a value is a usage error: exit 2, nothing written", () => {
  clearConfig();
  for (const args of [["config", "set"], ["config", "set", `${IMPLEMENT_ISSUE_SETTINGS}.openPr`]]) {
    const r = wf(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^usage: wf config set <dotted\.path> <value> \[--repo\]$/m);
  }
  assert.equal(existsSync(globalConfig()), false);
});

test("wf run takes --worktree and --no-pr as args.worktree = true and args.openPr = false, next to the args it was given", () => {
  const r = wf("run", "echoargs", "--args", '{"issue":5}', "--worktree", "--no-pr");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).result, { issue: 5, worktree: true, openPr: false });
  const one = wf("run", "echoargs", "--no-pr");
  assert.deepEqual(JSON.parse(one.stdout).result, { openPr: false });
  const none = wf("run", "echoargs", "--args", '{"openPr":true}');
  assert.deepEqual(JSON.parse(none.stdout).result, { openPr: true }, "without a shortcut the args are the user's alone");
});

test("wf start takes the same shortcuts: the job's workflow receives them", () => {
  const started = wf("start", "echoargs", "--worktree", "--no-pr");
  assert.equal(started.status, 0, started.stderr);
  const waited = wf("wait", JSON.parse(started.stdout).jobId, "--timeout", "120");
  assert.equal(waited.status, 0, waited.stderr);
  const state = JSON.parse(waited.stdout);
  assert.equal(state.status, "finished", waited.stdout);
  assert.deepEqual(state.result, { worktree: true, openPr: false });
});

test("a shortcut that contradicts the same key in --args is refused: exit 2, one line naming both, no job and no run", () => {
  const jobs = jobCount();
  for (const command of ["run", "start"]) {
    for (const [flag, args, key] of [["--worktree", '{"worktree":false}', "worktree"], ["--no-pr", '{"openPr":true}', "openPr"]] as const) {
      const r = wf(command, "echoargs", "--args", args, flag);
      assert.equal(r.status, 2, `${command} ${flag}: ${r.stderr}`);
      assert.equal(r.stdout, "");
      const lines = r.stderr.trimEnd().split("\n");
      assert.equal(lines.length, 1, r.stderr);
      assert.ok(lines[0]!.includes(flag) && lines[0]!.includes(`"${key}"`), lines[0]);
    }
  }
  assert.equal(jobCount(), jobs, "no job was created");
});

test("a shortcut that agrees with the same key in --args is accepted, and the shortcuts need --args to be a JSON object", () => {
  const agrees = wf("run", "echoargs", "--args", '{"openPr":false}', "--no-pr");
  assert.equal(agrees.status, 0, agrees.stderr);
  assert.deepEqual(JSON.parse(agrees.stdout).result, { openPr: false });
  const notObject = wf("run", "echoargs", "--args", "[1]", "--worktree");
  assert.equal(notObject.status, 2);
  assert.match(notObject.stderr, /--args must be a JSON object/);
});

const DELIVERY_CHILD = (modules: Record<"sdk" | "engine" | "workflow" | "fixture", string>) => `
import { script } from ${JSON.stringify(modules.sdk)};
import { runWorkflow } from ${JSON.stringify(modules.engine)};
import implementIssue from ${JSON.stringify(modules.workflow)};
import { CLEAN_REVIEW, SUB_CODE, SUB_TEST, labelOf, submit, write } from ${JSON.stringify(modules.fixture)};

const handlers = {
  "test-1": (o) => { write(o, "test/sub.test.js", SUB_TEST); submit(o, { testFile: "test/sub.test.js", testName: "subtract" }); },
  "code-1": (o) => { write(o, "src/math.js", SUB_CODE); submit(o, { summary: "subtract", filesChanged: ["src/math.js"] }); },
  "review:standards": (o) => submit(o, CLEAN_REVIEW),
  "review:spec": (o) => submit(o, CLEAN_REVIEW),
  "review:security": (o) => submit(o, CLEAN_REVIEW),
  "pr-text": (o) => submit(o, { summary: "subtract", door: "two-way", blastRadius: "local" }),
};
for (let i = 0; i < 50; i++) {
  script.push((o) => {
    const handler = handlers[labelOf(o).replace(/:\\d+$/, "")];
    if (!handler) throw new Error("no answer for the step " + labelOf(o));
    handler(o);
    return { status: "finished", result: "ok" };
  });
}
const outcome = await runWorkflow(implementIssue, JSON.parse(process.argv[2]), { cwd: process.argv[3] });
process.stdout.write(JSON.stringify({ status: outcome.status, error: outcome.error, result: outcome.result }));
`;

const DELIVERY_LAYERS: Array<{ name: string; global?: boolean; repo?: boolean; arg?: boolean; opens: boolean }> = [
  { name: "no setting and no arg", opens: true },
  { name: "the global file says false", global: false, opens: false },
  { name: "the repo file says true over a global false", global: false, repo: true, opens: true },
  { name: "the repo file says false over a global true", global: true, repo: false, opens: false },
  { name: "the arg says false over a repo true", repo: true, arg: false, opens: false },
  { name: "the arg says true over a global false", global: false, arg: true, opens: true },
];

for (const layer of DELIVERY_LAYERS) {
  test(`a run of implement-issue in its own process, ${layer.name}: ${layer.opens ? "a PR is opened" : "no PR is opened"}`, () => {
    setup();
    try {
      issue(["complexity:low"]);
      const settingsOf = (openPr: boolean) => ({ workflows: { "implement-issue": { settings: { openPr } } } });
      if (layer.global !== undefined) writeGlobalConfig(settingsOf(layer.global));
      if (layer.repo !== undefined) writeRepoConfig(fx.repo, settingsOf(layer.repo));
      const child = join(sandbox, "delivery-child.mts");
      writeFileSync(
        child,
        DELIVERY_CHILD({
          sdk: join(PACKAGE, "test", "fake-sdk.ts"),
          engine: join(PACKAGE, "src", "runtime", "engine.ts"),
          workflow: join(PACKAGE, "workflows", "implement-issue.ts"),
          fixture: join(PACKAGE, "test", "implement-issue.fixture.ts"),
        }),
      );
      const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: join(PACKAGE, "tsconfig.test.json") };
      delete env.NODE_TEST_CONTEXT;
      const args = { issue: 7, testCommand: "node --test", ...(layer.arg === undefined ? {} : { openPr: layer.arg }) };
      const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), child, JSON.stringify(args), fx.repo], { env, encoding: "utf8", timeout: 240_000 });
      assert.equal(r.status, 0, r.stderr);
      const outcome = JSON.parse(r.stdout) as { status: string; error?: string; result: { status: string; prUrl?: string } };
      assert.equal(outcome.status, "finished", outcome.error);
      assert.equal(outcome.result.status, "done", JSON.stringify(outcome.result));
      assert.equal(outcome.result.prUrl !== undefined, layer.opens);
      assert.equal(forgeState().prs.length, layer.opens ? 1 : 0);
    } finally {
      teardown();
    }
  });
}
