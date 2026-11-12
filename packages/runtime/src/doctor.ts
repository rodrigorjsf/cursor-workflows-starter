// `wf doctor`: checks the environment the kit needs and turns every silent setup failure into a message that says what to
// fix. Each check is independent: one that fails (or throws) does not stop the others, and the report lists them all in a
// fixed order. The checks follow what the IDE does: they read the MCP config it reads and start the server it starts.

import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Cursor } from "@cursor/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import semver from "semver";
import type { ConfigIssue } from "./config/file.js";
import { ConfigError, type ResolvedConfig, loadEffectiveConfig } from "./config/index.js";
import { type CheckId, type CheckResult, type DoctorReport, fail, nodeHint, pass, reportOf } from "./doctor-report.js";
import { kitCompatibility, kitFileUrl, readKitPackage } from "./kit-version.js";
import { MCP_CONFIG_FILES, type McpLaunch, type McpLaunches, readMcpLaunches } from "./mcp-launch.js";
import { createRedactor } from "./runtime/redaction.js";
import { loadWorkflows } from "./runtime/registry.js";
import type { WorkflowDefinition } from "./runtime/workflow.js";

export { type CheckResult, type DoctorReport, formatReport } from "./doctor-report.js";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** How long a call to a remote service or the MCP server may take before its check gives up. `WF_DOCTOR_TIMEOUT_MS` (milliseconds) changes it. */
function timeoutMs(): number {
  const fromEnv = Number(process.env.WF_DOCTOR_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 20_000;
}

/** `promise`, or a rejection after `ms`: the SDK and the MCP server have no timeout of their own that a check can rely on. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} não respondeu em ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The first executable called `name` on `path`, the way `/usr/bin/env node` (the shebang of the MCP command) finds it. */
function findOnPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}

/** The `node` that `path` resolves to and its version, against the range the kit supports. */
function probeNode(path: string | undefined, nodeRange: string): { ok: boolean; line: string } {
  const node = findOnPath("node", path);
  if (!node) return { ok: false, line: "nenhum `node` no PATH: o IDE não consegue iniciar o servidor MCP" };
  let version: string;
  try {
    version = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (err) {
    return { ok: false, line: `\`${node} --version\` falhou: ${messageOf(err)}` };
  }
  if (semver.satisfies(version, nodeRange)) return { ok: true, line: `${version} em ${node}` };
  return { ok: false, line: `${version} em ${node}; o @cursor/sdk exige Node ${nodeRange.replace(/^>=/, "")} ou mais novo` };
}

/**
 * The `node` on the PATH the server gets, because that is what starts it: the IDE runs the `tsx` command of `mcp.json`,
 * whose shebang is `env node`, with the PATH of its own environment plus the entry's `env`. The doctor sees the PATH of the
 * terminal it runs in, and a version manager's shell hook can make a terminal see another node than the IDE does: run
 * `wf doctor` from a terminal the IDE opened.
 */
function checkNode(mcp: McpLaunches): CheckResult {
  const { nodeRange } = readKitPackage();
  const minimum = semver.minVersion(nodeRange);
  type NodeProbe = { file: string | undefined; ownPath: boolean; ok: boolean; line: string };
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
  const missing = launches.length ? [] : [`nem ${MCP_CONFIG_FILES.join(" nem ")} registra o servidor "workflows"`];
  return { message: [...problems, ...missing].join("\n"), hint: "Rode `wf init` neste repositório: ele escreve as duas configs do servidor MCP (ou corrija o arquivo indicado)." };
}

/** The kit folder a `<kit>/node_modules/.bin/<command>` path belongs to; undefined for any other path. */
function kitRootOf(file: string): string | undefined {
  const at = file.indexOf("/node_modules/.bin/");
  return at === -1 ? undefined : file.slice(0, at);
}

/** The files the IDE needs to start the server: its command (`node_modules/.bin/tsx` of the kit) and the script it runs, found as the IDE finds them (from the repo). */
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
    (lost.length ? absent : found).push(`${file}: ${lost.length ? `${lost.join(", ")} não existe` : commandFile}`);
  }
  if (absent.length) {
    const where = kitRoot ? ` (${kitRoot})` : "";
    return fail("dependencies", absent.join("\n"), `Rode \`npm ci\` na pasta do kit${where} para instalar as dependências. Se a pasta não existe, o kit ainda não foi instalado nesse caminho: instale-o com o guia ${kitFileUrl("INSTALL-AGENT.md", readKitPackage().version)}`);
  }
  return pass("dependencies", found.join("\n"));
}

/** The SDK login: an authenticated call, so an expired or revoked key fails here and not in the middle of a run. */
async function checkLogin(): Promise<CheckResult> {
  try {
    const me = await within(Cursor.me(), timeoutMs(), "o Cursor");
    return pass("login", `chave "${me.apiKeyName}"`);
  } catch (err) {
    return fail("login", messageOf(err), "Faça login com `wf login` (abre o navegador) ou defina a variável CURSOR_API_KEY no ambiente que inicia o IDE.");
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
    await within(client.connect(transport), timeoutMs(), "o servidor MCP");
    const { tools } = await within(client.listTools(), timeoutMs(), "o servidor MCP");
    return { launch, tools: tools.map((t) => t.name), version: client.getServerVersion()?.version };
  } catch (err) {
    const printed = stderr.trim();
    return { launch, error: `${messageOf(err)}${printed ? `\n  o servidor escreveu no stderr:\n    ${printed.split("\n").slice(-8).join("\n    ")}` : ""}` };
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
    if (!p.tools?.includes("start_workflow")) return { ok: false, line: `${p.launch.file}: respondeu tools/list sem a tool start_workflow (tools: ${p.tools?.join(", ") || "nenhuma"})`, launch: p.launch };
    return { ok: true, line: `${p.launch.file}: respondeu tools/list com ${p.tools.join(", ")}`, launch: p.launch };
  });
  const failed = verdicts.filter((v) => !v.ok);
  if (!failed.length) return pass("mcp-server", verdicts.map((v) => v.line).join("\n"));
  const byHand = failed.map(({ launch }) => `\`${[launch.command, ...launch.args].join(" ")}\``).join(" ou ");
  return fail(
    "mcp-server",
    failed.map((v) => v.line).join("\n"),
    `Rode ${byHand} no repositório para ver o erro. Causas comuns: Node antigo no PATH do IDE, dependências do kit faltando, um workflow do repositório que não importa.`,
  );
}

/** `gh auth status`: the workflows that open pull requests and read issues run `gh` as the user, so it must be logged in. */
async function checkGh(): Promise<CheckResult> {
  if (!findOnPath("gh", process.env.PATH)) {
    return fail("gh", "`gh` não está no PATH", "Instale o GitHub CLI (https://cli.github.com) e rode `gh auth login`, no ambiente que inicia o IDE.");
  }
  try {
    await promisify(execFile)("gh", ["auth", "status"], { timeout: timeoutMs() });
    return pass("gh", "autenticado");
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.trim().split("\n")[0] ?? messageOf(err);
    return fail("gh", `\`gh auth status\` falhou: ${said}`, "Rode `gh auth login`.");
  }
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
    return { ok: false, message: `não foi possível carregar os workflows do repositório: ${messageOf(err)}` };
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
      else others.push(`o workflow ${def.meta.name} não resolve: ${messageOf(err)}`); // a malformed definition, say
    }
  }
  const problems = [...(issues.size ? [new ConfigError([...issues.values()]).message] : []), ...others];
  return problems.length ? { ok: false, message: problems.join("\n") } : { ok: true, workflows };
}

function checkConfig(resolution: Resolution): CheckResult {
  if (!resolution.ok) return fail("config", resolution.message, "Corrija os campos indicados. O `$schema` do arquivo dá autocompletar e validação no editor.");
  return pass("config", `${resolution.workflows.length} workflow(s) resolvidos com a configuração global e a do repositório`);
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
  if (!resolution.ok) return fail("models", "não foi possível saber quais modelos a configuração usa: ela não resolve (veja a verificação de configuração)", "Corrija a configuração primeiro.");
  let catalog: Awaited<ReturnType<typeof Cursor.models.list>>;
  try {
    catalog = await within(Cursor.models.list(), timeoutMs(), "o Cursor");
  } catch (err) {
    return fail("models", `não foi possível listar os modelos da conta: ${messageOf(err)}`, "Confira a verificação de login: o catálogo só vem com uma chave válida.");
  }
  const known = new Set(catalog.flatMap((m) => [m.id, ...(m.aliases ?? [])]));
  const used = configuredModels(resolution.workflows);
  const unknown = [...used].filter(([id]) => !known.has(id));
  if (unknown.length) {
    return fail(
      "models",
      unknown.map(([id, where]) => `o modelo "${id}" (${where.join(", ")}) não está no catálogo da conta`).join("\n"),
      "Rode `wf models` para ver os IDs liberados para a sua chave e troque o modelo na configuração (`workflows.<workflow>.roles.<papel>.model.id`) ou em `WF_MODEL_<PAPEL>`.",
    );
  }
  return pass("models", `${used.size} modelo(s) em uso, todos no catálogo da conta: ${[...used.keys()].join(", ")}`);
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
      .map((v) => (v.range === undefined ? `kit ${v.version} (${v.who}); o repositório não declara uma faixa (\`kit\` em .agents/workflows/config.json)` : `kit ${v.version} (${v.who}), dentro da faixa "${v.range}"`))
      .join("\n"),
  );
}

/** A check that throws is a failed check: the doctor exists to say what is wrong, not to crash on it. */
function guarded(id: CheckId, run: () => CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  return Promise.resolve()
    .then(run)
    .catch((err: unknown) => fail(id, `erro inesperado na verificação: ${messageOf(err)}`, "Rode `wf doctor` de novo; se o erro continuar, abra uma issue no repositório do kit com esta mensagem."));
}

/** Runs every check against the repo at `cwd`. Nothing in the report holds a secret: it is redacted like the run logs are. */
export async function runDoctor({ cwd }: { cwd: string }): Promise<DoctorReport> {
  const mcp = readMcpLaunches(cwd);
  const resolution = resolveWorkflows(cwd);
  const servers = Promise.all(mcp.launches.map(probeServer));
  const checks = await Promise.all([
    guarded("node", () => checkNode(mcp)),
    guarded("dependencies", () => checkDependencies(mcp)),
    guarded("login", checkLogin),
    guarded("models", async () => checkModels(await resolution)),
    guarded("gh", checkGh),
    guarded("mcp-server", async () => checkMcpServer(mcp, await servers)),
    guarded("config", async () => checkConfig(await resolution)),
    guarded("kit-version", async () => checkKitVersion(cwd, await servers)),
  ]);
  return createRedactor().value(reportOf(checks));
}
