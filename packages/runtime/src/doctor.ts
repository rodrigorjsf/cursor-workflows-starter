// `wf doctor`: checks the environment the kit needs and turns every silent setup failure into a message that says what to
// fix. Each check is independent: one that fails (or throws) does not stop the others, and the report lists them all in a
// fixed order. The checks follow what the IDE does: they read the MCP config it reads and start the server it starts.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Cursor } from "@cursor/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import semver from "semver";
import type { ConfigIssue } from "./config/file.js";
import { ConfigError, type ResolvedConfig, loadEffectiveConfig } from "./config/index.js";
import { type CheckId, type CheckResult, type DoctorReport, fail, nodeHint, pass, reportOf, warn } from "./doctor-report.js";
import { findOnPath } from "./find-on-path.js";
import { SECURITY_TOKEN_SECTION, broadScopesOf, readTokenScopes } from "./github-token-scopes.js";
import { kitChanges, kitChangesMessage, kitTagsAtHead } from "./kit-state.js";
import { kitCompatibility, kitFileUrl, readKitPackage } from "./kit-version.js";
import { MCP_CONFIG_FILES, type McpLaunch, type McpLaunches, readMcpLaunches } from "./mcp-launch.js";
import { CURSOR_ENDPOINT_VARIABLES, cursorEndpointProblems, schemeAndHost } from "./runtime/cursor-endpoints.js";
import { errorText } from "./runtime/error-text.js";
import { createRedactor } from "./runtime/redaction.js";
import { REPO_CODE_INTRO, loadsProjectSettings, repoCommandLines, repoCommandsIn } from "./runtime/repo-code.js";
import { loadWorkflows } from "./runtime/registry.js";
import { isRecord } from "./runtime/parse-json.js";
import { stateRootIn, userDir } from "./runtime/state.js";
import { WSL_INTEROP_FILES, WSL_INTEROP_FILES_ENV, readWslInterop } from "./wsl-interop.js";
import type { WorkflowDefinition } from "./runtime/workflow.js";
import { type ForgeLogin, type ForgeToken, type OriginForge, forgeOfOrigin, loginOf } from "../workflows/implement-issue/forge.js";

export { type CheckResult, type DoctorReport, formatReport } from "./doctor-report.js";

/** How long a call to a remote service or the MCP server may take before its check gives up. `WF_DOCTOR_TIMEOUT_MS` (milliseconds) changes it. */
function timeoutMs(): number {
  const fromEnv = Number(process.env.WF_DOCTOR_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 20_000;
}

/** The WSL interop files the host check reads: the kernel's own, or the ones `WF_DOCTOR_WSL_INTEROP_FILES` lists (as a PATH does), for the tests. */
function interopFiles(): readonly string[] {
  const fromEnv = (process.env[WSL_INTEROP_FILES_ENV] ?? "").split(delimiter).filter(Boolean);
  return fromEnv.length ? fromEnv : WSL_INTEROP_FILES;
}

/** `promise`, or a rejection after `ms`: the SDK and the MCP server have no timeout of their own that a check can rely on. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The `node` that `path` resolves to and its version, against the range the kit supports. */
function probeNode(path: string | undefined, nodeRange: string): { ok: boolean; line: string } {
  const node = findOnPath("node", path);
  if (!node) return { ok: false, line: "no `node` on the PATH: the IDE cannot start the MCP server" };
  let version: string;
  try {
    version = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (err) {
    return { ok: false, line: `\`${node} --version\` failed: ${errorText(err)}` };
  }
  if (semver.satisfies(version, nodeRange)) return { ok: true, line: `${version} at ${node}` };
  return { ok: false, line: `${version} at ${node}; @cursor/sdk needs Node ${nodeRange.replace(/^>=/, "")} or newer` };
}

function checkNode(mcp: McpLaunches): CheckResult {
  const { nodeRange } = readKitPackage();
  const minimum = semver.minVersion(nodeRange);
  interface NodeProbe {
    file: string | undefined;
    ownPath: boolean;
    ok: boolean;
    line: string;
  }
  const probes: NodeProbe[] = mcp.launches.length
    ? mcp.launches.map((l) => ({ file: l.file, ownPath: l.env.PATH !== undefined, ...probeNode(l.env.PATH ?? process.env.PATH, nodeRange) }))
    : [{ file: undefined, ownPath: false, ...probeNode(process.env.PATH, nodeRange) }];
  // Name the config file when its entry sets its own PATH or the entries disagree; otherwise every file says the same thing.
  const named = probes.some((p) => p.ownPath) || new Set(probes.map((p) => p.line)).size > 1;
  const lines = (list: NodeProbe[]) => (named ? list.map((p) => `${p.file}: ${p.line}`) : [list[0]!.line]).join("\n");
  const failed = probes.filter((p) => !p.ok);
  return failed.length ? fail("node", lines(failed), nodeHint(minimum ? `${minimum.major}.${minimum.minor}` : nodeRange)) : pass("node", lines(probes));
}

/** Why the MCP config cannot start the server at all: no file with the entry, or one that is broken. Undefined when it is usable. */
function mcpConfigFailure({ launches, problems }: McpLaunches): { message: string; hint: string } | undefined {
  if (launches.length && !problems.length) return undefined;
  const missing = launches.length ? [] : [`neither ${MCP_CONFIG_FILES.join(" nor ")} registers the "workflows" server`];
  return { message: [...problems, ...missing].join("\n"), hint: "Run `wf init` in this repository: it writes both MCP server configs (or fix the file named above)." };
}

function kitRootOf(file: string): string | undefined {
  const at = file.indexOf("/node_modules/");
  return at === -1 ? undefined : file.slice(0, at);
}

function checkDependencies(mcp: McpLaunches): CheckResult {
  const broken = mcpConfigFailure(mcp);
  if (broken) return fail("dependencies", broken.message, broken.hint);
  const absent: string[] = [];
  const found: string[] = [];
  let kitRoot: string | undefined;
  for (const { file, command, args, env, cwd } of mcp.launches) {
    const commandFile = command.includes("/") ? command : (findOnPath(command, env.PATH ?? process.env.PATH) ?? command);
    const scripts = args.filter((a) => /\.(ts|js|mjs|cjs)$/.test(a)).map((a) => resolve(cwd, a));
    const lost = [commandFile, ...scripts].filter((f) => !existsSync(f));
    kitRoot ??= lost.map(kitRootOf).find(Boolean);
    (lost.length ? absent : found).push(`${file}: ${lost.length ? `${lost.join(", ")} does not exist` : commandFile}`);
  }
  if (absent.length) {
    const where = kitRoot ? ` (${kitRoot})` : "";
    return fail("dependencies", absent.join("\n"), `Run \`npm ci\` in the kit folder${where} to install the dependencies. If the folder does not exist, the kit is not installed at that path yet: install it with the guide ${kitFileUrl("INSTALL-AGENT.md", readKitPackage().version)}`);
  }
  return pass("dependencies", found.join("\n"));
}

/**
 * Where the SDK would send the API key: the address in `CURSOR_BACKEND_URL` (the API and the token exchange) and `CURSOR_WEBSITE_URL`
 * (login), which it reads from the environment and uses with no check of its own. Both must be unset or an https URL on cursor.sh or
 * cursor.com. The doctor's own environment is read, and so is the `env` of each MCP entry, because the server the IDE starts gets it.
 * The report shows the scheme and host of a value, never the rest of it. Until this check passes, the checks that call the SDK do not run.
 */
function checkEndpoints(mcp: McpLaunches): CheckResult {
  const sources = [{ where: "", env: process.env as Record<string, string | undefined> }, ...mcp.launches.map((l) => ({ where: `${l.file}: `, env: l.env }))];
  const problems = sources.flatMap(({ where, env }) => cursorEndpointProblems(env).map((p) => ({ variable: p.variable, line: `${where}${p.message}` })));
  if (problems.length) {
    const names = [...new Set(problems.map((p) => p.variable))];
    return fail(
      "endpoints",
      problems.map((p) => p.line).join("\n"),
      `Unset ${names.join(" and ")} in the environment that starts the IDE (and in the "env" of the MCP entry, when the message names its file), or set ${names.length > 1 ? "them" : "it"} to an https URL on cursor.sh or cursor.com. ` +
        "Until then the login and models checks do not run: asking Cursor would send your API key to that address, and the kit refuses to start a run with it too.",
    );
  }
  const set = sources.flatMap(({ where, env }) => CURSOR_ENDPOINT_VARIABLES.flatMap((name) => (env[name] ? [`${where}${name}=${schemeAndHost(env[name]!)}`] : [])));
  return pass("endpoints", set.length ? set.join("\n") : `neither ${CURSOR_ENDPOINT_VARIABLES.join(" nor ")} is set: the SDK uses Cursor's own endpoints`);
}

/** The login and models checks ask Cursor, which sends the key to the address the endpoints check refused: they stay unrun. */
const notRun = (id: "login" | "models"): CheckResult =>
  fail(id, "not run: the endpoints check failed, and asking Cursor would send your API key to the address it names", "Fix the endpoints check first.");

/**
 * What a passing login adds: the SDK exposes no public way to read Privacy Mode (`Cursor.me()` has no such field, and an internal export
 * is not an interface), so the doctor cannot check it and reminds the reader to. `INSTALL-AGENT.md` quotes the first words.
 */
const PRIVACY_MODE_REMINDER = "Privacy Mode cannot be read through the SDK: confirm it is on in Cursor Settings > General";

/** The SDK login: an authenticated call, so an expired or revoked key fails here and not in the middle of a run. */
async function checkLogin(): Promise<CheckResult> {
  try {
    const me = await within(Cursor.me(), timeoutMs(), "Cursor");
    return pass("login", `key "${me.apiKeyName}"\n${PRIVACY_MODE_REMINDER}`);
  } catch (err) {
    return fail("login", errorText(err), "Log in with `wf login` (it opens the browser) or set CURSOR_API_KEY in the environment that starts the IDE.");
  }
}

/** What starting one server of the repo's MCP config showed: its tools and kit version, or why it did not answer. */
interface ServerProbe {
  launch: McpLaunch;
  tools?: string[];
  /** The version the server reports in `initialize`: the kit the IDE would start. */
  version?: string;
  error?: string;
}

/** Starts the server as the IDE does (its command, args and env, in the repo), asks it for `tools/list`, and stops it. */
async function probeServer(launch: McpLaunch): Promise<ServerProbe> {
  const { command, args, env, cwd } = launch;
  const transport = new StdioClientTransport({ command, args, cwd, env: { ...(process.env as Record<string, string>), ...env }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr = `${stderr}${chunk}`.slice(-2000)));
  const client = new Client({ name: "wf-doctor", version: readKitPackage().version });
  try {
    await within(client.connect(transport), timeoutMs(), "the MCP server");
    const { tools } = await within(client.listTools(), timeoutMs(), "the MCP server");
    return { launch, tools: tools.map((t) => t.name), version: client.getServerVersion()?.version };
  } catch (err) {
    const printed = stderr.trim();
    return { launch, error: `${errorText(err)}${printed ? `\n  the server wrote on stderr:\n    ${printed.split("\n").slice(-8).join("\n    ")}` : ""}` };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** The MCP server answering `tools/list`: what the IDE needs to show the kit's tools in the chat. */
function checkMcpServer(mcp: McpLaunches, probes: ServerProbe[]): CheckResult {
  const broken = mcpConfigFailure(mcp);
  if (broken) return fail("mcp-server", broken.message, broken.hint);
  const verdicts = probes.map((p) => {
    if (p.error !== undefined) return { ok: false, line: `${p.launch.file}: ${p.error}`, launch: p.launch };
    if (!p.tools?.includes("start_workflow")) return { ok: false, line: `${p.launch.file}: answered tools/list without the start_workflow tool (tools: ${p.tools?.join(", ") || "none"})`, launch: p.launch };
    return { ok: true, line: `${p.launch.file}: answered tools/list with ${p.tools.join(", ")}`, launch: p.launch };
  });
  const failed = verdicts.filter((v) => !v.ok);
  if (!failed.length) return pass("mcp-server", verdicts.map((v) => v.line).join("\n"));
  const byHand = failed.map(({ launch }) => `\`${[launch.command, ...launch.args].join(" ")}\``).join(" or ");
  return fail(
    "mcp-server",
    failed.map((v) => v.line).join("\n"),
    `Run ${byHand} in the repository to see the error. Common causes: an old Node on the IDE's PATH, missing kit dependencies, a repository workflow that does not import.`,
  );
}

/** The first lines of what a failed command printed (its stderr, else its stdout): what it said about why it failed. */
function saidBy(err: unknown): string {
  const { stderr, stdout } = err as { stderr?: string; stdout?: string };
  const printed = [stderr, stdout].map((text) => text?.trim() ?? "").find((text) => text !== "") ?? "";
  const lines = printed.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length ? lines.slice(0, 4).join("\n") : errorText(err);
}

/** How a `git` call ended: `exitCode` is undefined when it did not run or was killed at the timeout; `said` is what it printed when it failed. */
interface GitResult {
  exitCode: number | undefined;
  stdout: string;
  said: string;
}

/** `git` in `cwd`, in the C locale: git translates its messages, and the check reads one of them (outside a repository). */
async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await promisify(execFile)("git", args, { cwd, timeout: timeoutMs(), encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    return { exitCode: 0, stdout, said: "" };
  } catch (err) {
    const { code, stdout } = err as { code?: unknown; stdout?: string };
    return { exitCode: typeof code === "number" ? code : undefined, stdout: stdout ?? "", said: saidBy(err) };
  }
}

/** What the forge check says when the CLI has a login. */
const authenticatedLine = (login: ForgeLogin): string => `${login.service}: \`${login.cli}\` is authenticated`;

/**
 * What the token the forge CLI would use against `host` can do, once the CLI has said there is a login (`token` is the forge's way to
 * ask, GitHub's today): a warning when it holds a scope the kit does not need (`BROAD_SCOPES`), because any step that can print the
 * token can use every power it has. A fine-grained token has no scopes header to read, so it passes; a call that cannot be made is a
 * warning too, not a failure: the login itself is fine. Nothing of the token or of the response but the scopes header is read or printed.
 */
async function checkForgeToken(login: ForgeLogin, token: ForgeToken): Promise<CheckResult> {
  const authenticated = authenticatedLine(login);
  const fromEnv = token.envNames.find((name) => (process.env[name] ?? "") !== "");
  const scopes = await readTokenScopes(login.cli, token.scopesArgs, timeoutMs());
  const securityDoc = `See "${SECURITY_TOKEN_SECTION}" in ${kitFileUrl("SECURITY.md", readKitPackage().version)}.`;
  switch (scopes.kind) {
    case "unreadable":
      return warn(
        "forge",
        `${authenticated}, but could not read the token's scopes: ${scopes.said}`,
        `Run \`${[login.cli, ...token.scopesArgs].join(" ")}\` to see the error, then \`wf doctor\` again. The check compares the scopes with the ones the kit does not need. ${securityDoc}`,
      );
    case "none":
      return pass(
        "forge",
        fromEnv
          ? `${authenticated}; a scoped token is in use (${fromEnv}): GitHub sent no \`X-OAuth-Scopes\` header, which is what it does for a fine-grained token`
          : `${authenticated}; GitHub sent no \`X-OAuth-Scopes\` header for the stored token, which is what it does for a fine-grained token, so there are no scopes to check`,
      );
    case "listed": {
      const broad = broadScopesOf(scopes.scopes);
      if (broad.length === 0) return pass("forge", `${authenticated}; the token's scopes are ${scopes.scopes.join(", ") || "none"}`);
      const narrower = `a fine-grained token limited to the target repository, with an expiry, in ${token.envNames[0]}`;
      return warn(
        "forge",
        `${authenticated}, but its token holds scopes the kit does not need: ${broad.join(", ")}. Any step that can run \`${token.printCommand}\` can use them, and revoking the token does not undo an SSH key, a workflow file or a deleted repository.`,
        fromEnv
          ? `${fromEnv} holds a classic token, whose scopes cannot be removed: replace it with ${narrower}. ${securityDoc}`
          : `Remove them with \`${token.removeScopesCommand(broad)}\`, or use ${narrower}. ${securityDoc}`,
      );
    }
  }
}

/**
 * Is this repository's forge ready: the CLI of the forge the `origin` remote names (`gh` for GitHub, `glab` for GitLab, found as
 * a run finds it, through the `forges` map of the config), installed and logged in. The workflows that open pull requests and read
 * issues run it as the user. Outside a git repository, or in one with no `origin`, no forge is asked for and the check passes.
 * For GitHub, a login that works is also asked what its token can do (`checkForgeToken`).
 */
async function checkForge(cwd: string, resolution: Resolution): Promise<CheckResult> {
  if (!findOnPath("git", process.env.PATH)) {
    return fail("forge", "`git` is not on the PATH: the `origin` remote, which names the forge, cannot be read", "Install git (https://git-scm.com), in the environment that starts the IDE.");
  }
  const inside = await runGit(cwd, ["rev-parse", "--git-dir"]);
  if (inside.exitCode === 128 && /not a git repository/i.test(inside.said)) return pass("forge", "not inside a git repository: there is no forge to check");
  if (inside.exitCode !== 0) return fail("forge", `\`git rev-parse --git-dir\` failed: ${inside.said}`, "Run `git status` in the repository to see the error.");
  const origin = await runGit(cwd, ["config", "--get", "remote.origin.url"]);
  if (origin.exitCode === 1) return pass("forge", "the repository has no `origin` remote: there is no forge to check");
  if (origin.exitCode !== 0) return fail("forge", `\`git config --get remote.origin.url\` failed: ${origin.said}`, "Run `git remote -v` in the repository to see the error.");

  // Every workflow resolves the same `forges`: the map the config files declare. A host the kit knows needs none of it.
  const declared = resolution.ok ? (resolution.workflows[0]?.resolved.config.forges ?? {}) : {};
  const url = origin.stdout.trim();
  let found: OriginForge;
  try {
    found = forgeOfOrigin(url === "" ? undefined : url, declared);
  } catch (err) {
    return resolution.ok
      ? fail("forge", errorText(err), "Declare the host under `forges` in `.agents/workflows/config.json` (this repository) or in the global config, as the message shows.")
      : fail("forge", `cannot tell which forge the origin is: ${errorText(err)}\nThe config that may declare the host does not resolve (see the configuration check).`, "Fix the configuration first.");
  }
  const login = loginOf(found.forge, found.host);
  if (!findOnPath(login.cli, process.env.PATH)) return fail("forge", `${login.service}: \`${login.cli}\` is not on the PATH`, login.installHint);
  try {
    await promisify(execFile)(login.cli, login.args, { timeout: timeoutMs() });
  } catch (err) {
    return fail("forge", `${login.service}: \`${[login.cli, ...login.args].join(" ")}\` failed: ${saidBy(err)}`, `Run \`${login.loginCommand}\`.`);
  }
  return login.token ? checkForgeToken(login, login.token) : pass("forge", authenticatedLine(login));
}

/** A workflow of the repo with the config it resolves to. */
interface ResolvedWorkflow {
  def: WorkflowDefinition;
  resolved: ResolvedConfig;
}

/** Every workflow of the repo with its config, or why that could not be done. */
type Resolution = { ok: true; workflows: ResolvedWorkflow[] } | { ok: false; message: string };

async function resolveWorkflows(cwd: string): Promise<Resolution> {
  let defs: WorkflowDefinition[];
  try {
    defs = [...(await loadWorkflows(cwd)).values()];
  } catch (err) {
    return { ok: false, message: `could not load the repository's workflows: ${errorText(err)}` };
  }
  // Every workflow resolves the same two files, so one bad file shows up once per workflow: list each issue once.
  const issues = new Map<string, ConfigIssue>();
  const others: string[] = [];
  const workflows: ResolvedWorkflow[] = [];
  for (const def of defs) {
    try {
      workflows.push({ def, resolved: loadEffectiveConfig(def, { cwd }) });
    } catch (err) {
      if (err instanceof ConfigError) for (const issue of err.issues) issues.set(JSON.stringify(issue), issue);
      else others.push(`workflow ${def.meta.name} does not resolve: ${errorText(err)}`); // a malformed definition, say
    }
  }
  const problems = [...(issues.size ? [new ConfigError([...issues.values()]).message] : []), ...others];
  return problems.length ? { ok: false, message: problems.join("\n") } : { ok: true, workflows };
}

/**
 * The configuration resolves, and, when a step can load the project's settings (`settingSources` includes "project", the default), the
 * hooks and MCP servers this repository declares are listed, because they run on this machine: a warning, since the repository may be one
 * you trust. The kit's own `workflows` server is not listed.
 */
function checkConfig(cwd: string, resolution: Resolution): CheckResult {
  if (!resolution.ok) return fail("config", resolution.message, "Fix the fields named above. The file's `$schema` gives autocompletion and validation in the editor.");
  const resolved = `${resolution.workflows.length} workflow(s) resolved with the global and the repository config`;
  const commands = resolution.workflows.some(({ resolved: { config } }) => loadsProjectSettings(config)) ? repoCommandsIn(cwd) : [];
  if (commands.length === 0) return pass("config", resolved);
  return warn(
    "config",
    `${resolved}\n${REPO_CODE_INTRO}:\n${repoCommandLines(commands).join("\n")}`,
    `Read these commands, and run a workflow here only if you trust this repository. To keep a step from loading them, take "project" out of \`caps.allowedSettingSources\` in ~/.cursor-workflows/config.json (the installer's default lists it). What the kit does on your machine is in ${kitFileUrl("SECURITY.md", readKitPackage().version)}.`,
  );
}

/** Every model id the workflows end up using, each with the places that ask for it (`implement-issue.roles.review`). */
function configuredModels(workflows: ResolvedWorkflow[]): Map<string, string[]> {
  const models = new Map<string, string[]>();
  const add = (id: string | undefined, where: string) => id === undefined || models.set(id, [...(models.get(id) ?? []), where]);
  for (const { def, resolved } of workflows) {
    const name = def.meta.name;
    add(def.defaults?.model?.id, `${name}.defaults`);
    for (const [role, settings] of Object.entries(resolved.config.roles)) add(settings.model?.id, `${name}.roles.${role}`);
    for (const [glob, settings] of Object.entries(resolved.config.labels)) add(settings.model?.id, `${name}.labels.${glob}`);
  }
  return models;
}

/** The models the config uses against the account's catalog: a model the SDK does not know fails the step that asks for it. */
async function checkModels(resolution: Resolution): Promise<CheckResult> {
  if (!resolution.ok) return fail("models", "cannot tell which models the config uses: it does not resolve (see the configuration check)", "Fix the configuration first.");
  let catalog: Awaited<ReturnType<typeof Cursor.models.list>>;
  try {
    catalog = await within(Cursor.models.list(), timeoutMs(), "Cursor");
  } catch (err) {
    return fail("models", `could not list the account's models: ${errorText(err)}`, "See the login check: the catalog comes only with a valid key.");
  }
  const known = new Set(catalog.flatMap((m) => [m.id, ...(m.aliases ?? [])]));
  const used = configuredModels(resolution.workflows);
  const unknown = [...used].filter(([id]) => !known.has(id));
  if (unknown.length) {
    return fail(
      "models",
      unknown.map(([id, where]) => `model "${id}" (${where.join(", ")}) is not in the account's catalog`).join("\n"),
      "Run `wf models` to see the IDs your key can use, and change the model in the config (`workflows.<workflow>.roles.<role>.model.id`) or in `WF_MODEL_<ROLE>`.",
    );
  }
  return pass("models", `${used.size} model(s) in use, all in the account's catalog: ${[...used.keys()].join(", ")}`);
}

/**
 * The `kit` range the repo declares against the kit that runs `wf` and against the kit each MCP entry would start (the version
 * its server reports): the second is the one `start_workflow` refuses, and it is not always the first.
 */
function checkKitVersion(cwd: string, probes: ServerProbe[]): CheckResult {
  const holders = [{ who: "wf", version: readKitPackage().version }, ...probes.flatMap((p) => (p.version ? [{ who: p.launch.file, version: p.version }] : []))];
  const byVersion = new Map<string, string[]>();
  for (const { who, version } of holders) byVersion.set(version, [...(byVersion.get(version) ?? []), who]);
  const verdicts = [...byVersion].map(([version, who]) => ({ who: who.join(", "), ...kitCompatibility(cwd, version) }));
  const problems = verdicts.filter((v) => v.problem);
  if (problems.length) {
    return fail("kit-version", problems.map((v) => `${v.who}: ${v.problem!.message}`).join("\n"), [...new Set(problems.map((v) => v.problem!.hint))].join(" "));
  }
  return pass(
    "kit-version",
    verdicts
      .map((v) => (v.range === undefined ? `kit ${v.version} (${v.who}); the repository declares no range (\`kit\` in .agents/workflows/config.json)` : `kit ${v.version} (${v.who}), within the range "${v.range}"`))
      .join("\n"),
  );
}

/** What the `readBoundary` of a Cursor `sandbox.json` is: undefined when the file is missing, does not parse or sets none. */
function readBoundaryOf(file: string): unknown {
  try {
    const config: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(config) ? config.readBoundary : undefined;
  } catch (err) {
    if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * The SDK sandbox, when the global caps require it (`caps.requireSandbox`): on Linux it needs `bwrap` on the PATH, and a step can
 * still read `~/.cursor/sdk/auth.json` until a `sandbox.json` sets `readBoundary` to `workspace`. The kit measured the sandbox on Linux
 * (issue #62): it blocked the network and a write outside the repository in every run, and a read of the key only with that setting
 * in the repository's `.cursor/sandbox.json`. The user's `~/.cursor/sandbox.json` was not measured (Cursor documents it as applying to
 * every workspace, with the repository's file taking priority), so the report says so. The sandbox also ran, on a kernel with Landlock,
 * with no usable `bwrap`; the doctor cannot test Landlock, so it asks for bubblewrap, which is the dependency the SDK documents.
 */
function checkSandbox(cwd: string, resolution: Resolution): CheckResult {
  if (!resolution.ok) return fail("sandbox", "cannot tell whether the sandbox is required: the config does not resolve (see the configuration check)", "Fix the configuration first.");
  if (resolution.workflows[0]?.resolved.config.caps.requireSandbox !== true) {
    return pass("sandbox", "not required: `caps.requireSandbox` is not true, so a step uses the SDK sandbox only when its workflow asks for it");
  }
  const bwrap = process.platform === "linux" ? findOnPath("bwrap", process.env.PATH) : undefined;
  if (process.platform === "linux" && !bwrap) {
    return fail(
      "sandbox",
      "`caps.requireSandbox` is true and `bwrap` is not on the PATH: the SDK sandbox needs bubblewrap on Linux (a kernel with Landlock, version 6.2 or newer, may run it without; the doctor cannot test that, so it asks for bubblewrap)",
      "Install bubblewrap (`sudo apt install bubblewrap`, `sudo dnf install bubblewrap`) in the environment that starts the IDE, and run `wf doctor` again from a terminal the IDE opened. To run steps without the sandbox, set `caps.requireSandbox` to false in ~/.cursor-workflows/config.json.",
    );
  }
  const inRepo = readBoundaryOf(join(cwd, ".cursor", "sandbox.json"));
  const inHome = readBoundaryOf(join(homedir(), ".cursor", "sandbox.json"));
  const reads =
    inRepo === "workspace"
      ? 'reads are limited to the workspace (`readBoundary` is "workspace" in .cursor/sandbox.json)'
      : inRepo === undefined && inHome === "workspace"
        ? '`readBoundary` is "workspace" in ~/.cursor/sandbox.json, which Cursor documents for every workspace but the kit has not measured (it measured the repository\'s .cursor/sandbox.json): confirm that a step cannot read ~/.cursor/sdk/auth.json'
        : '`readBoundary` is not "workspace" in .cursor/sandbox.json or ~/.cursor/sandbox.json, so a step can still read ~/.cursor/sdk/auth.json: run `wf init`, which sets it to "workspace" in the repository\'s .cursor/sandbox.json, to block that read';
  return pass("sandbox", `\`caps.requireSandbox\` is true${bwrap ? `, bubblewrap at ${bwrap}` : `, and ${process.platform} needs no bubblewrap`}; ${reads}`);
}

/** The `version` of the kit's runtime package at `kit`: undefined when the manifest is missing or is not JSON with a version. */
function installedKitVersion(kit: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(kit, "packages", "runtime", "package.json"), "utf8"));
    return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined; // the manifest is missing or broken: the caller reports a kit with no readable version
  }
}

/**
 * The installed kit (`~/.cursor-workflows/kit`): a tag install must be on exactly the tag of its package version and have a clean
 * tree. The kit holds the engine that enforces the caps, the redaction and the tool allowlists, any unsandboxed step can write to
 * it, and an edit survives `wf upgrade` (`kit-state.ts`). A development install (a link to a working copy, `install.sh --dev`) is
 * reported as such and not checked, as `wf upgrade` does not touch it either. With no kit at that path there is nothing to check.
 */
function checkKit(): CheckResult {
  const kit = join(userDir(), "kit");
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(kit);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return pass("kit", `no kit is installed at ${kit}: nothing to check`);
    throw err;
  }
  if (entry.isSymbolicLink()) return pass("kit", `development install: ${kit} points to ${readlinkSync(kit)}, a working copy that is not checked`);

  const hint = `Reinstall the kit: move ${kit} aside (it keeps the changes, if you want to look at them) and install the kit again with the guide ${kitFileUrl("INSTALL-AGENT.md", readKitPackage().version)}. The global config and the skill links stay.`;
  if (!existsSync(join(kit, ".git"))) return fail("kit", `${kit} is not a git clone of the kit, so its version and its changes cannot be checked`, hint);
  const version = installedKitVersion(kit);
  if (version === undefined) return fail("kit", `the kit at ${kit} has no readable package version (packages/runtime/package.json)`, hint);

  const problems: string[] = [];
  try {
    const changes = kitChanges(kit);
    if (changes.length) problems.push(kitChangesMessage(kit, changes));
    const tags = kitTagsAtHead(kit);
    if (!tags.includes(`v${version}`)) problems.push(`HEAD of the kit at ${kit} is ${tags.length ? `tagged ${tags.join(", ")}` : "not tagged"}, and the tag of its package version is v${version}`);
  } catch (err) {
    return fail("kit", errorText(err), hint); // names the kit it could not read
  }
  return problems.length ? fail("kit", problems.join("\n"), hint) : pass("kit", `${kit} is at v${version} with a clean tree`);
}

/**
 * The repo's run state (`.workflows/`): the event logs, journals and memo hold the private source and the step results of the repo,
 * so no other user of the machine should be able to enter the folder. A kit older than this check, or a loose umask, made it
 * readable; a folder that exists keeps its mode, so the doctor says so (a warning) and how to close it. Only reads: it never makes
 * the folder. A folder is private when group and others have no permission on it at all: without the execute bit they could not
 * read its files, and with it a file whose name they know is theirs to read.
 */
function checkState(cwd: string): CheckResult {
  const folder = stateRootIn(cwd);
  if (process.platform === "win32") return pass("state", "Windows has no Unix modes: nothing to check");
  let mode: number;
  try {
    mode = statSync(folder).mode & 0o777;
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return pass("state", `no run state in this repository yet (${folder} does not exist): nothing to check`);
    throw err;
  }
  if ((mode & 0o077) === 0) return pass("state", `${folder} is mode ${mode.toString(8)}: only its user can enter it`);
  return warn(
    "state",
    `${folder} is mode ${mode.toString(8)}: other users of this machine can enter it, and what is inside (event logs with prompts and command output, journals and memo with step results) is private source`,
    `Run \`chmod 700 ${folder}\`: nobody else can then reach what is inside, whatever the files' own modes (this kit makes new state \`0600\` in a \`0700\` folder). On a drive that has no Unix modes (WSL's /mnt/c) the mode cannot be changed: keep the repository in the Linux file system.`,
  );
}

/**
 * The host the kit runs on, as far as the WSL trust boundary goes: on WSL2 with interop on, a Windows process reaches this Linux home
 * through `\\wsl$` as the distribution's default user, so the 0600 mode of `~/.cursor/sdk/auth.json` does not keep it out, and a step that
 * runs without the SDK sandbox can start Windows programs. That is a warning, since the boundary is the user's to choose per repository;
 * the doctor reads the kernel's interop files and never changes `wsl.conf` or restarts WSL. A host with no interop file (not WSL, or
 * interop off) passes. `WF_DOCTOR_WSL_INTEROP_FILES` replaces the files' paths, for the tests.
 */
function checkHost(): CheckResult {
  const files = interopFiles();
  const interop = readWslInterop(files);
  const securityDoc = `See the paragraph on WSL in ${kitFileUrl("SECURITY.md", readKitPackage().version)}.`;
  switch (interop.kind) {
    case "absent":
      return pass("host", `no WSL interop: ${files.join(" and ")} do not exist, so this host is not WSL, or its interop is off`);
    case "disabled":
      return pass("host", `WSL interop is off: ${interop.file} reads "${interop.reads}", so a step cannot start Windows programs from this distribution`);
    case "unreadable":
      return warn("host", `could not read ${interop.file}: ${interop.said}. The doctor cannot tell whether WSL interop is on, which decides whether a step can start Windows programs`, `Check the file's permissions, or ignore this on a host that is not WSL. ${securityDoc}`);
    case "enabled":
      return warn(
        "host",
        `WSL interop is on (${interop.file} reads "enabled"). A Windows process reaches this Linux home through \\\\wsl$ as the distribution's default user, so the 0600 mode of ~/.cursor/sdk/auth.json does not keep it out, and a step that runs without the SDK sandbox can start Windows programs`,
        `For a repository you do not trust, work in a separate WSL distribution, or turn interop off in this one: put \`[interop]\` and \`enabled=false\` in its /etc/wsl.conf, then stop the distribution from Windows (\`wsl --terminate <distribution>\`) and start it again. The doctor never changes or restarts WSL. ${securityDoc}`,
      );
  }
}

/** A check that throws is a failed check: the doctor exists to say what is wrong, not to crash on it. */
function guarded(id: CheckId, run: () => CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  return Promise.resolve()
    .then(run)
    .catch((err: unknown) => fail(id, `unexpected error in the check: ${errorText(err)}`, "Run `wf doctor` again; if the error persists, open an issue on the kit's repository with this message."));
}

/** Runs every check against the repo at `cwd`. Nothing in the report holds a secret: it is redacted like the run logs are. */
export async function runDoctor({ cwd }: { cwd: string }): Promise<DoctorReport> {
  const mcp = readMcpLaunches(cwd);
  const resolution = resolveWorkflows(cwd);
  const servers = Promise.all(mcp.launches.map(probeServer));
  const endpoints = guarded("endpoints", () => checkEndpoints(mcp));
  const checks = await Promise.all([
    guarded("node", () => checkNode(mcp)),
    guarded("dependencies", () => checkDependencies(mcp)),
    endpoints,
    guarded("login", async () => ((await endpoints).status === "fail" ? notRun("login") : checkLogin())),
    guarded("models", async () => ((await endpoints).status === "fail" ? notRun("models") : checkModels(await resolution))),
    guarded("forge", async () => checkForge(cwd, await resolution)),
    guarded("mcp-server", async () => checkMcpServer(mcp, await servers)),
    guarded("config", async () => checkConfig(cwd, await resolution)),
    guarded("kit-version", async () => checkKitVersion(cwd, await servers)),
    guarded("sandbox", async () => checkSandbox(cwd, await resolution)),
    guarded("kit", checkKit),
    guarded("state", () => checkState(cwd)),
    guarded("host", checkHost),
  ]);
  return createRedactor().value(reportOf(checks));
}
