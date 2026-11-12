// `wf doctor`: checks the environment the kit needs and turns every silent setup failure into a message that says what to
// fix. Each check is independent: one that fails does not stop the others, and the report lists them all in a fixed order.

import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { Cursor } from "@cursor/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import semver from "semver";
import { ConfigError, type ResolvedConfig, loadEffectiveConfig } from "./config/index.js";
import type { ConfigIssue } from "./config/file.js";
import { kitCompatibility, readKitPackage } from "./kit-version.js";
import { MCP_CONFIG_FILES, type McpLaunch, type McpLaunches, readMcpLaunches } from "./mcp-launch.js";
import { loadWorkflows } from "./runtime/registry.js";
import type { WorkflowDefinition } from "./runtime/workflow.js";

export type CheckStatus = "pass" | "fail";

export interface CheckResult {
  /** Stable name of the check, for scripts reading `--json`. */
  id: string;
  title: string;
  status: CheckStatus;
  /** What was found (several lines when there are several problems). */
  message: string;
  /** How to fix it. Present on every failure. */
  hint?: string;
}

export interface DoctorReport {
  /** True when every check passed. */
  ok: boolean;
  checks: CheckResult[];
}

const pass = (id: string, title: string, message: string): CheckResult => ({ id, title, status: "pass", message });
const fail = (id: string, title: string, message: string, hint: string): CheckResult => ({ id, title, status: "fail", message, hint });

/** An error's message with the API key taken out: the report may end up in a chat or an issue. */
const messageOf = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  const key = process.env.CURSOR_API_KEY;
  return key ? message.replaceAll(key, "[chave omitida]") : message;
};

/** How long a call to a remote service or the MCP server may take before its check gives up. `WF_DOCTOR_TIMEOUT_MS` shortens it for tests. */
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

/**
 * The `node` on the PATH, because that is what starts the MCP server: the IDE runs the `tsx` command of `mcp.json`, whose
 * shebang is `env node`. It is not necessarily the node running `wf`, and a version manager's shell hook can make a terminal
 * see another node than the IDE does: run `wf doctor` from a terminal the IDE opened.
 */
function checkNode(): CheckResult {
  const title = "Node.js";
  const { nodeRange } = readKitPackage();
  const hint =
    "Instale o Node 22.13 ou mais novo e deixe-o como padrão no ambiente que inicia o IDE (por exemplo `mise use -g node@22` ou `nvm alias default 22`), depois reinicie o IDE. " +
    "Confira com `which node && node -v` num terminal aberto pelo próprio IDE.";
  const node = findOnPath("node", process.env.PATH);
  if (!node) return fail("node", title, "nenhum `node` no PATH: o IDE não consegue iniciar o servidor MCP", hint);
  let version: string;
  try {
    version = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (err) {
    return fail("node", title, `\`${node} --version\` falhou: ${messageOf(err)}`, hint);
  }
  if (!semver.satisfies(version, nodeRange)) return fail("node", title, `${version} em ${node}; o @cursor/sdk exige Node ${nodeRange.replace(/^>=/, "")} ou mais novo`, hint);
  return pass("node", title, `${version} em ${node}`);
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

/** The files the IDE needs to start the server: its command (`node_modules/.bin/tsx` of the kit) and the script it runs. */
function checkDependencies(mcp: McpLaunches): CheckResult {
  const title = "Dependências instaladas";
  const broken = mcpConfigFailure(mcp);
  if (broken) return fail("dependencies", title, broken.message, broken.hint);
  const absent: string[] = [];
  const found: string[] = [];
  let kitRoot: string | undefined;
  for (const { file, command, args } of mcp.launches) {
    const commandFile = command.includes("/") ? command : findOnPath(command, process.env.PATH) ?? command;
    const scripts = args.filter((a) => /\.(ts|js|mjs|cjs)$/.test(a));
    const lost = [commandFile, ...scripts].filter((f) => !existsSync(f));
    kitRoot ??= lost.map(kitRootOf).find(Boolean);
    (lost.length ? absent : found).push(`${file}: ${lost.length ? `${lost.join(", ")} não existe` : commandFile}`);
  }
  if (absent.length) {
    const where = kitRoot ? ` (${kitRoot})` : "";
    return fail("dependencies", title, absent.join("\n"), `Rode \`npm ci\` na pasta do kit${where} para instalar as dependências. Se a pasta não existe, o kit ainda não foi instalado nesse caminho.`);
  }
  return pass("dependencies", title, found.join("\n"));
}

/** The SDK login: an authenticated call, so an expired or revoked key fails here and not in the middle of a run. */
async function checkLogin(): Promise<CheckResult> {
  const title = "Login no Cursor SDK";
  try {
    const me = await within(Cursor.me(), timeoutMs(), "o Cursor");
    return pass("login", title, `chave "${me.apiKeyName}"`);
  } catch (err) {
    return fail("login", title, messageOf(err), "Faça login com `wf login` (abre o navegador) ou defina a variável CURSOR_API_KEY no ambiente que inicia o IDE.");
  }
}

/** Starts the server as the IDE does (its command, args and env, in the repo), asks it for `tools/list`, and stops it. */
async function listServerTools({ command, args, env, cwd }: McpLaunch): Promise<string[]> {
  const transport = new StdioClientTransport({ command, args, cwd, env: { ...(process.env as Record<string, string>), ...env }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr = `${stderr}${chunk}`.slice(-2000)));
  const client = new Client({ name: "wf-doctor", version: readKitPackage().version });
  try {
    await within(client.connect(transport), timeoutMs(), "o servidor MCP");
    return (await within(client.listTools(), timeoutMs(), "o servidor MCP")).tools.map((t) => t.name);
  } catch (err) {
    const printed = stderr.trim();
    throw new Error(`${messageOf(err)}${printed ? `\n  o servidor escreveu no stderr:\n    ${printed.split("\n").slice(-8).join("\n    ")}` : ""}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** The MCP server answering `tools/list`: what the IDE needs to show the kit's tools in the chat. */
async function checkMcpServer(mcp: McpLaunches): Promise<CheckResult> {
  const title = "Servidor MCP";
  const broken = mcpConfigFailure(mcp);
  if (broken) return fail("mcp-server", title, broken.message, broken.hint);
  const answers = await Promise.all(
    mcp.launches.map(async (launch) => {
      try {
        const tools = await listServerTools(launch);
        return tools.includes("start_workflow")
          ? { ok: true, line: `${launch.file}: respondeu tools/list com ${tools.join(", ")}` }
          : { ok: false, line: `${launch.file}: respondeu tools/list sem a tool start_workflow (tools: ${tools.join(", ") || "nenhuma"})`, launch };
      } catch (err) {
        return { ok: false, line: `${launch.file}: ${messageOf(err)}`, launch };
      }
    }),
  );
  const failed = answers.filter((a) => !a.ok);
  if (!failed.length) return pass("mcp-server", title, answers.map((a) => a.line).join("\n"));
  const byHand = failed.map(({ launch }) => `\`${[launch!.command, ...launch!.args].join(" ")}\``).join(" ou ");
  return fail(
    "mcp-server",
    title,
    failed.map((a) => a.line).join("\n"),
    `Rode ${byHand} no repositório para ver o erro. Causas comuns: Node antigo no PATH do IDE, dependências do kit faltando, um workflow do repositório que não importa.`,
  );
}

/** `gh auth status`: the workflows that open pull requests and read issues run `gh` as the user, so it must be logged in. */
async function checkGh(): Promise<CheckResult> {
  const title = "GitHub CLI (gh)";
  const hint = "Instale o GitHub CLI (https://cli.github.com) e rode `gh auth login`, no ambiente que inicia o IDE.";
  if (!findOnPath("gh", process.env.PATH)) return fail("gh", title, "`gh` não está no PATH", hint);
  try {
    await promisify(execFile)("gh", ["auth", "status"], { timeout: timeoutMs() });
    return pass("gh", title, "autenticado");
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.trim().split("\n")[0] ?? messageOf(err);
    return fail("gh", title, `\`gh auth status\` falhou: ${said}`, "Rode `gh auth login`.");
  }
}

/** Every workflow of the repo with the config it resolves to, or why that could not be done. */
type Resolution = { ok: true; workflows: Array<{ def: WorkflowDefinition; resolved: ResolvedConfig }> } | { ok: false; message: string };

async function resolveWorkflows(cwd: string): Promise<Resolution> {
  let defs: WorkflowDefinition[];
  try {
    defs = [...(await loadWorkflows(cwd)).values()];
  } catch (err) {
    return { ok: false, message: `não foi possível carregar os workflows do repositório: ${messageOf(err)}` };
  }
  // Every workflow resolves the same two files, so one bad file shows up once per workflow: list each issue once.
  const issues = new Map<string, ConfigIssue>();
  const workflows: Array<{ def: WorkflowDefinition; resolved: ResolvedConfig }> = [];
  for (const def of defs) {
    try {
      workflows.push({ def, resolved: loadEffectiveConfig(def, { cwd }) });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      for (const issue of err.issues) issues.set(JSON.stringify(issue), issue);
    }
  }
  return issues.size ? { ok: false, message: new ConfigError([...issues.values()]).message } : { ok: true, workflows };
}

function checkConfig(resolution: Resolution): CheckResult {
  const title = "Configuração";
  if (!resolution.ok) return fail("config", title, resolution.message, "Corrija os campos indicados. O `$schema` do arquivo dá autocompletar e validação no editor.");
  return pass("config", title, `${resolution.workflows.length} workflow(s) resolvidos com a configuração global e a do repositório`);
}

/** Every model id the workflows end up using, each with the places that ask for it (`implement-issue.roles.review`). */
function configuredModels(workflows: Array<{ def: WorkflowDefinition; resolved: ResolvedConfig }>): Map<string, string[]> {
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
  const title = "Modelos da configuração";
  if (!resolution.ok) return fail("models", title, "não foi possível saber quais modelos a configuração usa: ela não resolve (veja a verificação de configuração)", "Corrija a configuração primeiro.");
  let catalog: Awaited<ReturnType<typeof Cursor.models.list>>;
  try {
    catalog = await within(Cursor.models.list(), timeoutMs(), "o Cursor");
  } catch (err) {
    return fail("models", title, `não foi possível listar os modelos da conta: ${messageOf(err)}`, "Confira a verificação de login: o catálogo só vem com uma chave válida.");
  }
  const known = new Set(catalog.flatMap((m) => [m.id, ...(m.aliases ?? [])]));
  const used = configuredModels(resolution.workflows);
  const unknown = [...used].filter(([id]) => !known.has(id));
  if (unknown.length) {
    return fail(
      "models",
      title,
      unknown.map(([id, where]) => `o modelo "${id}" (${where.join(", ")}) não está no catálogo da conta`).join("\n"),
      "Rode `wf models` para ver os IDs liberados para a sua chave e troque o modelo na configuração (`workflows.<workflow>.roles.<papel>.model.id`) ou em `WF_MODEL_<PAPEL>`.",
    );
  }
  return pass("models", title, `${used.size} modelo(s) em uso, todos no catálogo da conta: ${[...used.keys()].join(", ")}`);
}

/** The running kit against the `kit` range the repo declares. */
function checkKitVersion(cwd: string): CheckResult {
  const title = "Versão do kit";
  const { version, range, problem } = kitCompatibility(cwd);
  if (problem) return fail("kit-version", title, problem.message, problem.hint);
  return pass("kit-version", title, range === undefined ? `kit ${version}; o repositório não declara uma faixa (\`kit\` em .agents/workflows/config.json)` : `kit ${version}, dentro da faixa "${range}"`);
}

/** Runs every check against the repo at `cwd`. */
export async function runDoctor({ cwd }: { cwd: string }): Promise<DoctorReport> {
  const mcp = readMcpLaunches(cwd);
  const resolution = await resolveWorkflows(cwd);
  const checks = await Promise.all([checkNode(), checkDependencies(mcp), checkLogin(), checkModels(resolution), checkGh(), checkMcpServer(mcp), checkConfig(resolution), checkKitVersion(cwd)]);
  return { ok: checks.every((c) => c.status === "pass"), checks };
}

/** The report as text for a terminal: one block per check, the fix hint under each failure. */
export function formatReport(report: DoctorReport): string {
  const indent = (text: string) => text.split("\n").join("\n        ");
  const lines = report.checks.flatMap((c) => [
    `${c.status === "pass" ? "[ok]   " : "[FALHA]"} ${c.title}: ${indent(c.message)}`,
    ...(c.status === "fail" && c.hint ? [`        como corrigir: ${indent(c.hint)}`] : []),
  ]);
  const failed = report.checks.filter((c) => c.status === "fail").length;
  lines.push("", failed ? `${failed} de ${report.checks.length} verificações falharam.` : `Tudo certo: ${report.checks.length} verificações passaram.`);
  return `${lines.join("\n")}\n`;
}
