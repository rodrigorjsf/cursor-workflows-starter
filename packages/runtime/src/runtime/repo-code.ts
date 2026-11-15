// The code a target repository can run on this machine through the settings a step loads. A step whose `settingSources` include
// "project" (the engine's default) makes the Cursor SDK load the repository's own configuration, and that configuration is code: the
// hooks of `.cursor/hooks.json` and `.claude/settings.json` run shell commands, and the servers of `.cursor/mcp.json` are started
// as processes. A repository you cloned can set all of that. Nothing here stops it: `wf doctor` and the start of a run list it, so
// the person who owns the machine can see what the repository will run before it does (SECURITY.md).
//
// Read only, and forgiving: a file that is missing or is not the JSON it should be is skipped, because naming what it holds is all
// this is for. The kit's own `workflows` MCP server, which `wf init` writes, is not a finding.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SettingSource } from "@cursor/sdk";
import { allowedSources } from "../config/index.js";
import type { EffectiveConfig } from "./events.js";

/** The setting sources a step loads when its role, its call and the run's options say none: the engine's default. */
export const DEFAULT_SETTING_SOURCES: SettingSource[] = ["project", "team", "mdm"];

/** One command a repository's settings would run: where it is declared, which event or server, and the command line. */
export interface RepoCommand {
  /** The file, relative to the repository. */
  file: string;
  /** `beforeShellExecution` for a hook (the event it hangs on), `MCP server "docs"` for a server. */
  what: string;
  command: string;
}

/** The longest command line a listing shows; a hook can be a one-liner script. */
const COMMAND_MAX_CHARS = 200;
/** The most commands a listing names before it says how many more there are. */
const LIST_MAX = 20;
/** The name `wf init` gives the kit's own MCP server. */
const KIT_SERVER = "workflows";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const shown = (text: string): string => (text.length > COMMAND_MAX_CHARS ? `${text.slice(0, COMMAND_MAX_CHARS)}...` : text);

/** The parsed JSON object in `cwd/file`, or undefined when there is none or it is not one. */
function readObject(cwd: string, file: string): Record<string, unknown> | undefined {
  const path = join(cwd, file);
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Every string `command` in `value`, at any depth: Cursor lists `{ command }` entries under an event, Claude Code nests `{ hooks: [{ command }] }` under a matcher. */
function commandsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(commandsIn);
  if (!isObject(value)) return [];
  return [...(typeof value.command === "string" ? [value.command] : []), ...Object.values(value).flatMap(commandsIn)];
}

/** The hooks of a settings file (`hooks`, keyed by event), as `RepoCommand`s. */
function hooksOf(cwd: string, file: string): RepoCommand[] {
  const hooks = readObject(cwd, file)?.hooks;
  if (!isObject(hooks)) return [];
  return Object.entries(hooks).flatMap(([event, entries]) => commandsIn(entries).map((command) => ({ file, what: event, command: shown(command) })));
}

/** The MCP servers of `.cursor/mcp.json` that start a process, except the kit's own. */
function serversOf(cwd: string, file: string): RepoCommand[] {
  const servers = readObject(cwd, file)?.mcpServers;
  if (!isObject(servers)) return [];
  return Object.entries(servers).flatMap(([name, server]) => {
    if (name === KIT_SERVER || !isObject(server) || typeof server.command !== "string") return [];
    const args = Array.isArray(server.args) ? server.args.map(String) : [];
    return [{ file, what: `MCP server "${name}"`, command: shown([server.command, ...args].join(" ")) }];
  });
}

/** What the repository at `cwd` would run if a step loaded its project settings: its hooks, then its MCP servers. Empty when it declares none. */
export function repoCommandsIn(cwd: string): RepoCommand[] {
  return [...hooksOf(cwd, ".cursor/hooks.json"), ...hooksOf(cwd, ".claude/settings.json"), ...serversOf(cwd, ".cursor/mcp.json")];
}

/** The commands as lines of text, one each, the first `LIST_MAX` and a count of the rest. */
export function repoCommandLines(commands: RepoCommand[]): string[] {
  const lines = commands.slice(0, LIST_MAX).map(({ file, what, command }) => `${file} (${what}): ${command}`);
  return commands.length > LIST_MAX ? [...lines, `and ${commands.length - LIST_MAX} more`] : lines;
}

/**
 * Can a step of a run with this `config` load the project's settings? The setting sources a step gets are its role's or label's
 * (`config.roles`, `config.labels`, already cut by the global `caps.allowedSettingSources`), else `defaults` cut the same way. The check is
 * on the config alone: it does not know which steps a workflow will run, so a role that has its own sources does not hide the
 * default that a step without a role gets.
 */
export function loadsProjectSettings(config: Pick<EffectiveConfig, "caps" | "roles" | "labels">, defaults: SettingSource[] = DEFAULT_SETTING_SOURCES): boolean {
  if (allowedSources(config.caps.allowedSettingSources, defaults).includes("project")) return true;
  return [...Object.values(config.roles), ...Object.values(config.labels)].some((role) => role.settingSources?.includes("project"));
}

/** What `wf doctor` and the start of a run say about a repository whose settings run code, before the list: the start of every such message, which readers match on. */
export const REPO_CODE_INTRO = `the project's settings of this repository run code on this machine: steps load them (settingSources includes "project"), so these hooks and MCP servers can run, with your account's rights`;

/** The `warning` a run emits at its start for `commands`: the same list `wf doctor` shows, on one line. */
export const repoCodeWarning = (commands: RepoCommand[]): string => `${REPO_CODE_INTRO}: ${repoCommandLines(commands).join("; ")}`;
