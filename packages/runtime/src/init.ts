// `wf init`: writes the kit's files into a target repo. It plans every file first, then writes, and returns the changes so
// the caller can show them; it never runs git, so it never commits. Running it again plans no change.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { kitFileUrl, readKitPackage } from "./kit-version.js";
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

/** Where editors fetch the JSON Schema of the config files: raw JSON at the kit's release tag, so autocomplete matches the kit. */
const configSchemaUrl = (version: string) => kitFileUrl("packages/runtime/schema/config.schema.json", version, "raw");

type Json = Record<string, unknown>;

/** The semver range a repo declares for the kit that wrote its config: the minor line below 1.0, the major line from 1.0. */
function kitRange(version: string): string {
  const parts = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (!parts) throw new Error(`unreadable kit version: ${version}`);
  const [major, minor] = [Number(parts[1]), Number(parts[2])];
  return major === 0 ? `>=0.${minor}.0 <0.${minor + 1}.0` : `>=${major}.0.0 <${major + 1}.0.0`;
}

/** The JSON text of `next` when it differs from `current` (key order and formatting do not count), else undefined. */
function changedJson(next: Json, current: Json): string | undefined {
  return isDeepStrictEqual(next, current) ? undefined : `${JSON.stringify(next, null, 2)}\n`;
}

/** The repo config with `$schema` and `kit` first; what the file already says stays, including its own `kit` range. */
function withKitFields(file: string, existing: string | undefined, version: string): string | undefined {
  const config = parseObject(file, existing);
  return changedJson({ $schema: configSchemaUrl(version), kit: kitRange(version), ...config }, config);
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

/** Where the kit block sits in `text`; undefined when there is none. A begin marker without its end marker is an error. */
function findBlock(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(BLOCK_BEGIN);
  if (start === -1) return undefined;
  const end = text.indexOf(BLOCK_END, start);
  if (end === -1) throw new Error(`AGENTS.md: the kit block starts at "${BLOCK_BEGIN}" and has no "${BLOCK_END}" marker; fix the file and run \`wf init\` again`);
  return { start, end: end + BLOCK_END.length };
}

/** `AGENTS.md` with the kit's block appended after a blank line, or replacing the block of whatever kit version is already there. */
function withAgentsMdBlock(existing: string | undefined): string | undefined {
  const text = existing ?? "";
  const block = readFileSync(AGENTS_MD_BLOCK, "utf8").trimEnd();
  const found = findBlock(text);
  const next = found
    ? text.slice(0, found.start) + block + text.slice(found.end)
    : text === "" ? `${block}\n` : `${text.endsWith("\n") ? text : `${text}\n`}\n${block}\n`;
  return next === text ? undefined : next;
}

/** `AGENTS.md` without the kit's block, the blank line before it included. `null`: nothing else was in it, so the file goes. */
function withoutAgentsMdBlock(existing: string | undefined): string | null | undefined {
  const text = existing ?? "";
  const found = findBlock(text);
  if (!found) return undefined;
  const rest = text.slice(0, found.start).replace(/\n\n$/, "\n") + text.slice(found.end).replace(/^\n/, "");
  return rest.trim() === "" ? null : rest;
}

/** `existing` (a JSON file's text, if any) with the `workflows` MCP server set to `server`; the other servers and keys stay. */
function withWorkflowsServer(file: string, existing: string | undefined, server: { command: string; args: string[]; env?: Record<string, string> }): string | undefined {
  const config = parseObject(file, existing);
  const servers = (config.mcpServers ?? {}) as Json;
  const current = (servers.workflows ?? {}) as Json;
  const entry: Json = { ...current, command: server.command, args: server.args };
  if (server.env) entry.env = { ...(current.env as Json | undefined), ...server.env };
  return changedJson({ ...config, mcpServers: { ...servers, workflows: entry } }, config);
}

/** The command and arguments that start the kit's MCP server from `home`, the variable the client resolves to the user's home. */
const kitServer = (home: string) => ({
  command: `${home}/${KIT_FROM_HOME}/node_modules/.bin/tsx`,
  args: [`${home}/${KIT_FROM_HOME}/packages/runtime/src/mcp-server.ts`],
});

function parseObject(file: string, text: string | undefined): Json {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${err instanceof Error ? err.message : String(err)}); fix the file and run \`wf init\` again`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file}: expected a JSON object`);
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

export interface InitResult {
  /** What changed; empty when the repo is already set up. */
  changes: FileChange[];
  /** Things the user should know that init does not do for them. */
  notes: string[];
}

/**
 * The files that make Claude Code read them instead of AGENTS.md, in the working directory or any directory above it
 * (docs/usage/03-invocacao-no-cursor-ide.md; code.claude.com/docs/en/memory, "When Claude Code reads AGENTS.md").
 */
const CLAUDE_MEMORY_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];

/**
 * The `@path` imports of a memory file, the way Claude Code reads them: outside fenced code blocks and code spans, each path
 * relative to the file's folder (code.claude.com/docs/en/memory, "Import additional files"). Returns absolute paths.
 */
function importsOf(file: string): string[] {
  const paths: string[] = [];
  let fence: string | undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    for (const [, path] of line.replace(/(`+).*?\1/g, "").matchAll(/(?:^|\s)@(\S+)/g)) {
      paths.push(path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(dirname(file), path));
    }
  }
  return paths;
}

/**
 * Claude Code reads AGENTS.md only when no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md sits in the repo or in a directory
 * above it; ~/.claude/CLAUDE.md, the user's own memory, does not count, while ~/CLAUDE.md does. Says so when such a file
 * exists and none of them is AGENTS.md or imports it, with the import line that works from the file to edit.
 */
function claudeCodeNote(cwd: string): string | undefined {
  const root = realpathSync(cwd);
  const agents = realpathSync(join(root, "AGENTS.md"));
  const userMemory = join(homedir(), ".claude", "CLAUDE.md");
  const userMemoryReal = existsSync(userMemory) ? realpathSync(userMemory) : userMemory;
  const present: string[] = [];
  for (let dir = root; ; dir = dirname(dir)) {
    for (const file of CLAUDE_MEMORY_FILES) {
      const path = join(dir, file);
      if (statSync(path, { throwIfNoEntry: false })?.isFile() && realpathSync(path) !== userMemoryReal) present.push(path);
    }
    if (dirname(dir) === dir) break;
  }
  if (present.length === 0) return undefined;
  if (present.some((path) => realpathSync(path) === agents || importsOf(path).some((target) => existsSync(target) && realpathSync(target) === agents))) return undefined;

  // The repo's own files by their path in the repo, the ones above it by their absolute path.
  const shown = present.map((path) => (relative(root, path).startsWith("..") ? path : relative(root, path)));
  const target = CLAUDE_MEMORY_FILES.find((file) => shown.includes(file));
  const fix =
    target === undefined
      ? "create CLAUDE.md in the repository root with the line `@AGENTS.md`"
      : target === ".claude/CLAUDE.md"
        ? "add the line `@../AGENTS.md` to .claude/CLAUDE.md (an import resolves from the folder of the file that holds it)"
        : `add the line \`@AGENTS.md\` to ${target}`;
  return `Claude Code reads ${shown.join(" and ")}, not AGENTS.md: for it to see the kit block, ${fix}. wf init does not write Claude Code's memory files.`;
}

/** Plans the files, writes them, and returns what changed (nothing when the repo is already set up). */
export function initRepo({ cwd, skipAgentsMd = false, remove = false }: InitOptions): InitResult {
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the repository directory does not exist: ${cwd}`);
  if (skipAgentsMd && remove) throw new Error("--remove and --no-agents-md contradict each other: --remove only takes out the AGENTS.md block");
  const { version } = readKitPackage();
  /** Returns the file's new text; undefined when it needs no change, null when it should be deleted. */
  type Plan = (existing: string | undefined, path: string) => string | null | undefined;
  const agentsMd: [string, Plan] = ["AGENTS.md", remove ? withoutAgentsMdBlock : withAgentsMdBlock];
  const plans: Array<[string, Plan]> = remove
    ? [agentsMd]
    : [
        [".cursor/mcp.json", (text, path) => withWorkflowsServer(path, text, { ...kitServer("${userHome}"), env: { WF_CWD: "${workspaceFolder}" } })],
        [".mcp.json", (text, path) => withWorkflowsServer(path, text, kitServer("${HOME}"))],
        [".agents/workflows/config.json", (text, path) => withKitFields(path, text, version)],
        [".gitignore", withStateDirIgnored],
        ...(skipAgentsMd ? [] : [agentsMd]),
      ];

  // Plan everything before writing anything: a file that cannot be used leaves the repo as it was.
  const changes: FileChange[] = [];
  for (const [path, plan] of plans) {
    const before = readIfExists(join(cwd, path));
    const after = plan(before, path);
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
  const note = !remove && !skipAgentsMd && changes.some((c) => c.path === "AGENTS.md") ? claudeCodeNote(cwd) : undefined;
  return { changes, notes: note ? [note] : [] };
}
