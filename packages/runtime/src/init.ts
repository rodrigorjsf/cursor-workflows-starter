// `wf init`: writes the kit's files into a target repo. It plans every file first, then writes, and returns the changes so
// the caller can show them; it never runs git, so it never commits. Running it again plans no change.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomic } from "./runtime/state-files.js";

/** One file `wf init` changed. `before` is undefined for a new file, `after` for a deleted one. */
export interface FileChange {
  /** Relative to the target repo, with `/` separators. */
  path: string;
  before: string | undefined;
  after: string | undefined;
}

/** Where the installer puts the kit, relative to the user's home: the one fixed place every committed MCP config can name. */
const KIT_FROM_HOME = ".cursor-workflows/kit";

/** Where editors fetch the JSON Schema of the config files: raw JSON on the default branch, so it always resolves. */
const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/main/packages/runtime/schema/config.schema.json";

/** The runtime package, found from this module: the install location, never the repo root. */
const PACKAGE_JSON = join(import.meta.dirname, "..", "package.json");

type Json = Record<string, unknown>;

/** The semver range a repo declares for the kit that wrote its config: the minor line below 1.0, the major line from 1.0. */
function kitRange(version: string): string {
  const parts = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (!parts) throw new Error(`versão do kit ilegível: ${version}`);
  const [major, minor] = [Number(parts[1]), Number(parts[2])];
  return major === 0 ? `>=0.${minor}.0 <0.${minor + 1}.0` : `>=${major}.0.0 <${major + 1}.0.0`;
}

/** The repo config with `$schema` and `kit` first; what the file already says stays, including its own `kit` range. */
function withKitFields(file: string, existing: string | undefined, version: string): string | undefined {
  const config = parseObject(file, existing);
  const next: Json = { $schema: CONFIG_SCHEMA_URL, kit: kitRange(version), ...config };
  return isDeepStrictEqual(next, config) ? undefined : `${JSON.stringify(next, null, 2)}\n`;
}

/** The `.gitignore` with the runtime's state directory ignored: unchanged when one of its usual spellings is already there. */
function withStateDirIgnored(existing: string | undefined): string | undefined {
  const text = existing ?? "";
  if (text.split("\n").some((line) => [".workflows", ".workflows/", "/.workflows", "/.workflows/"].includes(line.trim()))) return undefined;
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}.workflows/\n`;
}

const BLOCK_BEGIN = "<!-- cursor-workflows:begin -->";
const BLOCK_END = "<!-- cursor-workflows:end -->";

/** The kit's `AGENTS.md` rules, from the templates folder of the install (the kit root, two levels above the runtime package). */
const AGENTS_MD_BLOCK = join(import.meta.dirname, "..", "..", "..", "templates", "agents-md-block.md");

/**
 * `AGENTS.md` with the kit's block added (appended after a blank line, or replacing the block of any kit version already
 * there) or, with `remove`, taken out. `null` means the file should not exist: removing the block left it empty.
 */
function withAgentsMdBlock(existing: string | undefined, remove: boolean): string | null | undefined {
  const text = existing ?? "";
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END, start);
  if (start !== -1 && end === -1) throw new Error(`AGENTS.md: o bloco do kit começa em "${BLOCK_BEGIN}" e não tem o marcador "${BLOCK_END}"; corrija o arquivo e rode \`wf init\` de novo`);
  const found = start === -1 ? undefined : { start, end: end + BLOCK_END.length };

  if (remove) {
    if (!found) return undefined;
    const rest = text.slice(0, found.start).replace(/\n\n$/, "\n") + text.slice(found.end).replace(/^\n/, "");
    return rest.trim() === "" ? null : rest;
  }
  const block = readFileSync(AGENTS_MD_BLOCK, "utf8").trimEnd();
  const next = found
    ? text.slice(0, found.start) + block + text.slice(found.end)
    : text === "" ? `${block}\n` : `${text.endsWith("\n") ? text : `${text}\n`}\n${block}\n`;
  return next === text ? undefined : next;
}

/** `existing` (a JSON file's text, if any) with the `workflows` MCP server set to `server`; the other servers and keys stay. */
function withWorkflowsServer(file: string, existing: string | undefined, server: { command: string; args: string[]; env?: Record<string, string> }): string | undefined {
  const config = parseObject(file, existing);
  const servers = (config.mcpServers ?? {}) as Json;
  const current = (servers.workflows ?? {}) as Json;
  const entry: Json = { ...current, command: server.command, args: server.args };
  if (server.env) entry.env = { ...(current.env as Json | undefined), ...server.env };
  const next: Json = { ...config, mcpServers: { ...servers, workflows: entry } };
  return isDeepStrictEqual(next, config) ? undefined : `${JSON.stringify(next, null, 2)}\n`;
}

function parseObject(file: string, text: string | undefined): Json {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: JSON inválido (${err instanceof Error ? err.message : String(err)}); corrija o arquivo e rode \`wf init\` de novo`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file}: esperava um objeto JSON`);
  return value as Json;
}

const readIfExists = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export interface InitOptions {
  cwd: string;
  /** Leave `AGENTS.md` alone. Default: false. */
  skipAgentsMd?: boolean;
  /** Take the kit block out of `AGENTS.md` and do nothing else. Default: false. */
  remove?: boolean;
}

/** Plans the files, writes them, and returns what changed (nothing when the repo is already set up). */
export function initRepo({ cwd, skipAgentsMd = false, remove = false }: InitOptions): FileChange[] {
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`o diretório do repositório não existe: ${cwd}`);
  if (skipAgentsMd && remove) throw new Error("--remove e --no-agents-md se contradizem: --remove só desfaz o bloco do AGENTS.md");
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };
  const kitFiles: Array<[string, (existing: string | undefined) => string | null | undefined]> = [
    [
      ".cursor/mcp.json",
      (text) =>
        withWorkflowsServer(".cursor/mcp.json", text, {
          command: `\${userHome}/${KIT_FROM_HOME}/node_modules/.bin/tsx`,
          args: [`\${userHome}/${KIT_FROM_HOME}/packages/runtime/src/mcp-server.ts`],
          env: { WF_CWD: "${workspaceFolder}" },
        }),
    ],
    [
      ".mcp.json",
      (text) =>
        withWorkflowsServer(".mcp.json", text, {
          command: `\${HOME}/${KIT_FROM_HOME}/node_modules/.bin/tsx`,
          args: [`\${HOME}/${KIT_FROM_HOME}/packages/runtime/src/mcp-server.ts`],
        }),
    ],
    [".agents/workflows/config.json", (text) => withKitFields(".agents/workflows/config.json", text, version)],
    [".gitignore", withStateDirIgnored],
  ];
  const files = remove
    ? [["AGENTS.md", (text: string | undefined) => withAgentsMdBlock(text, true)] as const]
    : [...kitFiles, ...(skipAgentsMd ? [] : [["AGENTS.md", (text: string | undefined) => withAgentsMdBlock(text, false)] as const])];

  // Plan everything before writing anything: a file that cannot be used leaves the repo as it was.
  const changes: FileChange[] = [];
  for (const [path, plan] of files) {
    const before = readIfExists(join(cwd, path));
    const after = plan(before);
    if (after !== undefined) changes.push({ path, before, after: after ?? undefined });
  }
  for (const { path, after } of changes) {
    const file = join(cwd, path);
    if (after === undefined) {
      rmSync(file);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(existsSync(file) ? realpathSync(file) : file, after); // through a symlink, not over it
  }
  return changes;
}
