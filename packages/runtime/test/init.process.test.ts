// Seam 2, the process: `wf init` is spawned (against the fake Cursor SDK) in a temporary repo with a temporary home, and
// the tests read what it prints and the files it leaves. Covers the MCP configs of both clients, the repo config, the
// `.gitignore` entry, the `AGENTS.md` block (`--no-agents-md`, `--remove`), idempotence, the diff and the absence of a commit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const PACKAGE = join(import.meta.dirname, "..");
const KIT_ROOT = join(PACKAGE, "..", "..");

let sandbox: string;
let home: string;
let counter = 0;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wf-init-"));
  home = join(sandbox, "home");
  mkdirSync(home);
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** An empty directory for a target repo. */
function emptyRepo(): string {
  const repo = join(sandbox, `repo-${++counter}`);
  mkdirSync(repo);
  return repo;
}

const put = (path: string, content: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};
const read = (repo: string, ...p: string[]) => readFileSync(join(repo, ...p), "utf8");
const readJson = (repo: string, ...p: string[]) => JSON.parse(read(repo, ...p));

const childEnv = (tsconfig: string) => ({ ...getDefaultEnvironment(), HOME: home, WF_HOME: home, TSX_TSCONFIG_PATH: tsconfig, WF_METRICS: "off" });

/** Runs `wf init` of the kit at `kit` (the real one by default) in `repo`. */
function init(repo: string, args: string[] = [], kit = KIT_ROOT) {
  const runtime = join(kit, "packages", "runtime");
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(runtime, "src", "cli.ts"), "init", ...args, "--cwd", repo], {
    env: childEnv(join(runtime, "tsconfig.test.json")),
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("wf init writes the Cursor MCP config pointing at the per-user kit through ${userHome}, with no caps in env", () => {
  const repo = emptyRepo();
  const r = init(repo);
  assert.equal(r.status, 0, r.stderr);

  const server = readJson(repo, ".cursor", "mcp.json").mcpServers.workflows;
  assert.equal(server.command, "${userHome}/.cursor-workflows/kit/node_modules/.bin/tsx");
  assert.deepEqual(server.args, ["${userHome}/.cursor-workflows/kit/packages/runtime/src/mcp-server.ts"]);
  assert.deepEqual(server.env, { WF_CWD: "${workspaceFolder}" });
  assert.doesNotMatch(read(repo, ".cursor", "mcp.json"), /WF_MAX_/);
});

test("wf init writes the Claude Code MCP config for the same per-user kit", () => {
  const repo = emptyRepo();
  assert.equal(init(repo).status, 0);

  const server = readJson(repo, ".mcp.json").mcpServers.workflows;
  assert.equal(server.command, "${HOME}/.cursor-workflows/kit/node_modules/.bin/tsx");
  assert.deepEqual(server.args, ["${HOME}/.cursor-workflows/kit/packages/runtime/src/mcp-server.ts"]);
  assert.doesNotMatch(read(repo, ".mcp.json"), /WF_MAX_/);
});

/** What the IDE does with a server entry: substitute its variables, then start the command in `cwd`. */
async function toolsOfServer(server: { command: string; args: string[]; env?: Record<string, string> }, vars: Record<string, string>, cwd: string) {
  const resolveVars = (s: string) => Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll("${" + name + "}", value), s);
  const client = new Client({ name: "init-test", version: "0.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: resolveVars(server.command),
        args: server.args.map(resolveVars),
        cwd,
        env: { ...childEnv(join(PACKAGE, "tsconfig.test.json")), ...Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, resolveVars(v)])) },
      }),
    );
    const listed = await client.callTool({ name: "list_workflows", arguments: {} });
    return {
      tools: (await client.listTools()).tools.map((t) => t.name),
      workflows: (JSON.parse((listed.content as Array<{ text: string }>)[0]!.text) as Array<{ name: string }>).map((w) => w.name),
    };
  } finally {
    await client.close();
  }
}

test("both generated MCP configs start the kit's MCP server on the target repo, as the IDEs launch them", async () => {
  const repo = emptyRepo();
  put(join(repo, ".agents", "workflows", "repo-local.mjs"), 'export default { meta: { name: "repo-local", description: "workflow of the target repo" } };\n');
  assert.equal(init(repo).status, 0);

  // A user whose kit is installed at ~/.cursor-workflows/kit (here: a link to this checkout).
  const userHome = join(sandbox, "ide-home");
  mkdirSync(join(userHome, ".cursor-workflows"), { recursive: true });
  symlinkSync(KIT_ROOT, join(userHome, ".cursor-workflows", "kit"));

  const cursor = await toolsOfServer(readJson(repo, ".cursor", "mcp.json").mcpServers.workflows, { userHome, workspaceFolder: repo }, repo);
  const claude = await toolsOfServer(readJson(repo, ".mcp.json").mcpServers.workflows, { HOME: userHome }, repo);
  for (const seen of [cursor, claude]) {
    assert.ok(seen.tools.includes("start_workflow"), seen.tools.join());
    assert.ok(seen.workflows.includes("repo-local") && seen.workflows.includes("implement-issue"), seen.workflows.join());
  }
});

test("wf init writes nothing outside the target repo", () => {
  const before = readdirSync(home).sort();
  assert.equal(init(emptyRepo()).status, 0);
  assert.deepEqual(readdirSync(home).sort(), before);
});

const SCHEMA_URL = "https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/main/packages/runtime/schema/config.schema.json";

test("wf init writes a repo config with the schema address and a kit version range, which the kit accepts", () => {
  const repo = emptyRepo();
  assert.equal(init(repo).status, 0);

  const config = readJson(repo, ".agents", "workflows", "config.json");
  assert.equal(config.$schema, SCHEMA_URL);
  assert.match(config.kit, /^>=\d+\.\d+\.0 <\d+\.\d+\.0$/);
  assert.deepEqual(Object.keys(config).sort(), ["$schema", "kit"]);
  // The schema's own documented example uses the same address: one place to look it up.
  assert.equal(JSON.parse(readFileSync(join(PACKAGE, "schema", "config.schema.json"), "utf8")).examples[0].$schema, SCHEMA_URL);

  const shown = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(PACKAGE, "src", "cli.ts"), "config", "show", "--cwd", repo], {
    env: childEnv(join(PACKAGE, "tsconfig.test.json")),
    encoding: "utf8",
  });
  assert.equal(shown.status, 0, shown.stderr);
});

/** A copy of the kit (runtime package plus templates) at `version`, laid out like an installed checkout. */
function kitAt(version: string): string {
  const kit = join(sandbox, `kit-${++counter}`);
  const runtime = join(kit, "packages", "runtime");
  for (const entry of ["src", "workflows", "schema", "tsconfig.json", "tsconfig.test.json"]) cpSync(join(PACKAGE, entry), join(runtime, entry), { recursive: true });
  mkdirSync(join(runtime, "test"));
  cpSync(join(PACKAGE, "test", "fake-sdk.ts"), join(runtime, "test", "fake-sdk.ts"));
  cpSync(join(KIT_ROOT, "templates"), join(kit, "templates"), { recursive: true });
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")), version }));
  symlinkSync(join(KIT_ROOT, "node_modules"), join(kit, "node_modules"));
  return kit;
}

test("the kit range of the repo config is the minor line (0.x) or the major line of the kit that ran init", () => {
  const rangeFor = (version: string) => {
    const repo = emptyRepo();
    const r = init(repo, [], kitAt(version));
    assert.equal(r.status, 0, r.stderr);
    return readJson(repo, ".agents", "workflows", "config.json").kit;
  };
  assert.equal(rangeFor("0.2.3"), ">=0.2.0 <0.3.0");
  assert.equal(rangeFor("1.4.2"), ">=1.0.0 <2.0.0");
  assert.equal(rangeFor("0.7.1-rc.1"), ">=0.7.0 <0.8.0");
});

test("an existing repo config keeps its preferences and its own kit range; only what is missing is added", () => {
  const repo = emptyRepo();
  const mine = { kit: ">=0.1.0 <1.0.0", workflows: { "implement-issue": { maxCents: 300 } } };
  put(join(repo, ".agents", "workflows", "config.json"), mine);
  assert.equal(init(repo).status, 0);
  assert.deepEqual(readJson(repo, ".agents", "workflows", "config.json"), { $schema: SCHEMA_URL, ...mine });
});

test("wf init adds a .workflows/ entry to the .gitignore, creating the file when needed and keeping what is there", () => {
  const fresh = emptyRepo();
  assert.equal(init(fresh).status, 0);
  assert.equal(read(fresh, ".gitignore"), ".workflows/\n");

  const existing = emptyRepo();
  put(join(existing, ".gitignore"), "node_modules/\ndist/"); // no trailing newline
  assert.equal(init(existing).status, 0);
  assert.equal(read(existing, ".gitignore"), "node_modules/\ndist/\n.workflows/\n");
});

test("wf init leaves a .gitignore alone when it already ignores .workflows in any common spelling", () => {
  for (const entry of [".workflows", ".workflows/", "/.workflows", "/.workflows/"]) {
    const repo = emptyRepo();
    const text = `# mine\n${entry}\n`;
    put(join(repo, ".gitignore"), text);
    assert.equal(init(repo).status, 0);
    assert.equal(read(repo, ".gitignore"), text, entry);
  }
});

test("wf init works in a linked git worktree, where .git is a file", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const main = emptyRepo();
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "base");
  const linked = join(sandbox, `linked-${++counter}`);
  git(main, "worktree", "add", "-q", linked);
  assert.ok(existsSync(join(linked, ".git")) && !existsSync(join(linked, ".git", "HEAD")), ".git of a linked worktree is a file");

  const r = init(linked);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(linked, ".gitignore"), ".workflows/\n");
  assert.ok(existsSync(join(linked, ".mcp.json")) && existsSync(join(linked, ".agents", "workflows", "config.json")));
});

const BEGIN = "<!-- cursor-workflows:begin -->";
const END = "<!-- cursor-workflows:end -->";
const GUIDE_URL = "https://github.com/rodrigorjsf/cursor-workflows-starter/blob/main/INSTALL-AGENT.md";

/** The lines of the kit block in `text`, markers included, or undefined. */
function blockOf(text: string): string[] | undefined {
  const lines = text.split("\n");
  const from = lines.indexOf(BEGIN);
  return from === -1 ? undefined : lines.slice(from, lines.indexOf(END) + 1);
}

test("wf init creates AGENTS.md with a short block of the safety rules and a pointer to the install guide", () => {
  const repo = emptyRepo();
  assert.equal(init(repo).status, 0);

  const text = read(repo, "AGENTS.md");
  const block = blockOf(text)!;
  assert.equal(block[0], BEGIN);
  assert.equal(block.at(-1), END);
  assert.ok(block.length - 2 >= 3 && block.length - 2 <= 4, `${block.length - 2} lines between the markers`);
  assert.equal(text, `${block.join("\n")}\n`, "nothing but the block in a file init created");
  for (const rule of [/never print or log the Cursor API key/i, /never start a workflow from inside a workflow step/i, /`\/run-workflow`/, /commits, pushes and pull requests/i]) {
    assert.match(text, rule);
  }
  assert.ok(text.includes(GUIDE_URL), "pointer to the install guide");
});

test("wf init appends the block to an AGENTS.md that exists, after a blank line, keeping its content", () => {
  const repo = emptyRepo();
  put(join(repo, "AGENTS.md"), "# My repo\n\nRun `make test`.");
  assert.equal(init(repo).status, 0);
  const text = read(repo, "AGENTS.md");
  assert.ok(text.startsWith("# My repo\n\nRun `make test`.\n\n" + BEGIN + "\n"), text);
  assert.ok(text.endsWith(END + "\n"));
});

test("wf init writes through an AGENTS.md symlink to CLAUDE.md instead of replacing the link", () => {
  const repo = emptyRepo();
  put(join(repo, "CLAUDE.md"), "# Guide\n");
  symlinkSync("CLAUDE.md", join(repo, "AGENTS.md"));
  assert.equal(init(repo).status, 0);
  assert.equal(readlinkSync(join(repo, "AGENTS.md")), "CLAUDE.md");
  assert.ok(read(repo, "CLAUDE.md").startsWith("# Guide\n\n" + BEGIN));
});

test("wf init --no-agents-md skips AGENTS.md: it neither creates it nor touches an existing one", () => {
  const fresh = emptyRepo();
  assert.equal(init(fresh, ["--no-agents-md"]).status, 0);
  assert.ok(!existsSync(join(fresh, "AGENTS.md")));
  assert.ok(existsSync(join(fresh, ".mcp.json")), "the rest of init still runs");

  const existing = emptyRepo();
  put(join(existing, "AGENTS.md"), "# Mine\n");
  assert.equal(init(existing, ["--no-agents-md"]).status, 0);
  assert.equal(read(existing, "AGENTS.md"), "# Mine\n");
});

test("wf init --remove deletes the block and leaves the rest of AGENTS.md; a file that only held the block goes away", () => {
  const repo = emptyRepo();
  put(join(repo, "AGENTS.md"), "# My repo\n\nRun `make test`.\n");
  assert.equal(init(repo).status, 0);
  assert.equal(init(repo, ["--remove"]).status, 0);
  assert.equal(read(repo, "AGENTS.md"), "# My repo\n\nRun `make test`.\n");

  const only = emptyRepo();
  assert.equal(init(only).status, 0);
  assert.equal(init(only, ["--remove"]).status, 0);
  assert.ok(!existsSync(join(only, "AGENTS.md")));
  assert.ok(existsSync(join(only, ".mcp.json")), "--remove undoes the AGENTS.md block only");

  assert.equal(init(only, ["--remove"]).status, 0, "removing what is not there is not an error");
});

test("wf init replaces a block written by another version of the kit, in place", () => {
  const repo = emptyRepo();
  put(join(repo, "AGENTS.md"), `# Top\n\n${BEGIN}\n- an old rule\n${END}\n\n# Bottom\n`);
  const r = init(repo, ["--no-agents-md"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("AGENTS.md"), "skipped");
  const replaced = init(repo);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.ok(replaced.stdout.includes(`--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,7 +1,10 @@\n # Top\n \n ${BEGIN}\n-- an old rule\n+- Never print`), replaced.stdout);
  const text = read(repo, "AGENTS.md");
  assert.ok(!text.includes("an old rule"));
  assert.ok(text.startsWith("# Top\n\n" + BEGIN) && text.endsWith(END + "\n\n# Bottom\n"), text);
  assert.equal(text.split(BEGIN).length, 2, "still one block");
});

test("wf init refuses a block with a begin marker and no end marker, and changes nothing", () => {
  const repo = emptyRepo();
  put(join(repo, "AGENTS.md"), `# Top\n${BEGIN}\n- half a block\n`);
  const r = init(repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AGENTS\.md/);
  assert.ok(!existsSync(join(repo, ".mcp.json")), "no file was written");
  assert.equal(read(repo, "AGENTS.md"), `# Top\n${BEGIN}\n- half a block\n`);
});

test("wf init --remove and --no-agents-md contradict each other", () => {
  const r = init(emptyRepo(), ["--remove", "--no-agents-md"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--remove.*--no-agents-md|--no-agents-md.*--remove/);
});

/** Every file under `dir` (relative path -> text), skipping .git. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
      const rel = join(prefix, e.name);
      if (e.name === ".git") return [];
      return e.isDirectory() ? Object.entries(snapshot(dir, rel)) : [[rel, readFileSync(join(dir, rel), "utf8")] as const];
    }),
  );
}

test("running wf init twice changes nothing the second time and prints no diff", () => {
  const repo = emptyRepo();
  put(join(repo, "AGENTS.md"), "# Mine\n");
  const first = init(repo);
  assert.equal(first.status, 0, first.stderr);
  const after = snapshot(repo);
  assert.deepEqual(Object.keys(after).sort(), [".agents/workflows/config.json", ".cursor/mcp.json", ".gitignore", ".mcp.json", "AGENTS.md"]);

  const second = init(repo);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
  assert.deepEqual(snapshot(repo), after);
});

test("wf init does not rewrite a file that already says what it would write, whatever its formatting", () => {
  const repo = emptyRepo();
  assert.equal(init(repo).status, 0);
  const files = [".mcp.json", join(".cursor", "mcp.json"), join(".agents", "workflows", "config.json")];
  const compact = files.map((file) => JSON.stringify(readJson(repo, file)));
  files.forEach((file, i) => put(join(repo, file), compact[i]));
  const again = init(repo);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, "");
  files.forEach((file, i) => assert.equal(read(repo, file), compact[i], file));
});

test("wf init keeps the other MCP servers and the extra settings of an existing workflows server", () => {
  const repo = emptyRepo();
  put(join(repo, ".cursor", "mcp.json"), {
    mcpServers: {
      other: { command: "other-server" },
      workflows: { command: "old/tsx", args: ["old.ts"], env: { WF_MAX_CENTS: "100" }, disabled: false },
    },
  });
  assert.equal(init(repo).status, 0);
  const { other, workflows } = readJson(repo, ".cursor", "mcp.json").mcpServers;
  assert.deepEqual(other, { command: "other-server" });
  assert.equal(workflows.command, "${userHome}/.cursor-workflows/kit/node_modules/.bin/tsx");
  assert.deepEqual(workflows.env, { WF_MAX_CENTS: "100", WF_CWD: "${workspaceFolder}" });
  assert.equal(workflows.disabled, false);
});

test("wf init refuses a config file that is not valid JSON, names it, and writes no file at all", () => {
  const repo = emptyRepo();
  put(join(repo, ".mcp.json"), '{ "mcpServers": ');
  const r = init(repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.mcp\.json/);
  assert.deepEqual(Object.keys(snapshot(repo)), [".mcp.json"]);
});

test("wf init prints the diff of everything it changed, as a unified diff", () => {
  const repo = emptyRepo();
  put(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  const r = init(repo);
  assert.equal(r.status, 0, r.stderr);

  for (const file of [".cursor/mcp.json", ".mcp.json", ".agents/workflows/config.json", "AGENTS.md"]) {
    assert.ok(r.stdout.includes(`--- /dev/null\n+++ b/${file}\n`), `${file} is a new file in the diff`);
  }
  assert.ok(r.stdout.includes('+      "command": "${userHome}/.cursor-workflows/kit/node_modules/.bin/tsx",\n'));
  // A changed file shows the hunk with its context lines.
  assert.ok(r.stdout.includes("--- a/.gitignore\n+++ b/.gitignore\n@@ -1,2 +1,3 @@\n node_modules/\n dist/\n+.workflows/\n"), r.stdout);
});

test("wf init --remove prints the removal as a diff, a deleted file included", () => {
  const repo = emptyRepo();
  assert.equal(init(repo).status, 0);
  const r = init(repo, ["--remove"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--- a\/AGENTS\.md\n\+\+\+ \/dev\/null\n@@ -1,6 \+0,0 @@\n-<!-- cursor-workflows:begin -->\n/);
  assert.doesNotMatch(r.stdout, /mcp\.json/);
});

test("wf init creates no commit and stages nothing", () => {
  const repo = emptyRepo();
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const head = git("rev-parse", "HEAD");

  assert.equal(init(repo).status, 0);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("diff", "--cached", "--name-only"), "", "nothing staged");
  assert.deepEqual(git("status", "--porcelain").split("\n").map((l) => l.slice(3)).sort(), [".agents/", ".cursor/", ".gitignore", ".mcp.json", "AGENTS.md"]);
});

test("wf init in a directory that does not exist is an error, not a new directory", () => {
  const missing = join(sandbox, "no-such-repo");
  const r = init(missing);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no-such-repo/);
  assert.ok(!existsSync(missing));
});
