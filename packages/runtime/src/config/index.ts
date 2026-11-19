// Config: layered JSON config with global hard caps and named roles. `loadEffectiveConfig` reads the two files, the env
// and the overrides afresh on every call (a run start, a `start_workflow`, `wf config show`): nothing is cached.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkflowDefinition } from "../runtime/workflow.js";
import { isRecord } from "../runtime/parse-json.js";
import { PRIVATE_DIR, PRIVATE_FILE, writeFileAtomic } from "../runtime/state-files.js";
import { ConfigError, type ConfigFile, type ConfigIssue, type LoadedConfig, globalConfigPath, loadConfigFile, pointerOf, readConfigJson, repoConfigPath, validateConfigData } from "./file.js";
import { LIMIT_FIELDS, type FlagLimits, type LimitOverrides, type ResolvedConfig, resolveConfig } from "./resolve.js";

export { ConfigError, CONFIG_SCHEMA_PATH, REPO_CONFIG_FILE, globalConfigPath, repoConfigPath } from "./file.js";
export { LIMITS, LIMIT_FIELDS, type LimitField, STEP_OVERRIDE_FIELDS, limitOverridesSchema, allowedSources, isModelAllowed, type FlagLimits, type LimitOverrides, type ResolvedConfig, type StepOverrides } from "./resolve.js";

export interface LoadOptions {
  cwd: string;
  /** Default: `process.env`. */
  env?: Record<string, string | undefined>;
  flags?: FlagLimits;
  mcpOverrides?: LimitOverrides;
}

/** Throws `ConfigError` (every problem of both files at once, each with its file and field path) when a layer cannot be used. */
export function loadEffectiveConfig(workflow: Pick<WorkflowDefinition, "meta" | "defaults" | "budget">, opts: LoadOptions): ResolvedConfig {
  const issues: ConfigIssue[] = [];
  const load = (path: string): LoadedConfig | undefined => {
    try {
      return loadConfigFile(path);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      issues.push(...err.issues);
      return undefined;
    }
  };
  const global = load(globalConfigPath());
  const repo = load(repoConfigPath(opts.cwd));
  if (issues.length) throw new ConfigError(issues);
  return resolveConfig({ workflow, global, repo, env: opts.env ?? process.env, flags: opts.flags, mcpOverrides: opts.mcpOverrides });
}

/**
 * The chat's `overrides` as limit overrides. Only the shape is checked here (an object of numbers, `null` counting as a
 * loosening attempt); the config resolver rejects a number that is not a valid limit and ignores one that loosens.
 */
export function parseLimitOverrides(raw: unknown): LimitOverrides {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("overrides must be an object");
  const overrides: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(key)) throw new Error(`unknown override: ${key} (use ${LIMIT_FIELDS.join(", ")})`);
    if (value !== null && typeof value !== "number") throw new Error(`override ${key} must be a number`);
    overrides[key] = value;
  }
  return overrides;
}

export type ConfigScope = "global" | "repo";

export interface ConfigSetRequest {
  cwd: string;
  scope: ConfigScope;
  path: string;
  value: string;
  workflows: Iterable<WorkflowDefinition>;
}

export interface ConfigSetResult {
  file: string;
  scope: ConfigScope;
  path: string;
  value: unknown;
}

type Json = Record<string, unknown>;

const COMMAND = "wf config set";

const SCOPES: Record<ConfigScope, { file: (cwd: string) => string; otherFile: (cwd: string) => string; dirMode?: number; fileMode: number }> = {
  global: { file: globalConfigPath, otherFile: repoConfigPath, dirMode: PRIVATE_DIR, fileMode: PRIVATE_FILE },
  repo: { file: repoConfigPath, otherFile: globalConfigPath, fileMode: 0o666 },
};

const segmentsOf = (path: string): string[] => path.split(/(?<!\\)\./).map((segment) => segment.replaceAll("\\.", "."));

const valueOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const define = (node: Json, key: string, value: unknown): void => {
  Object.defineProperty(node, key, { value, enumerable: true, writable: true, configurable: true });
};

function readDocument(file: string): Json {
  const data = readConfigJson(file);
  if (data === undefined) return {};
  if (!isRecord(data)) throw new ConfigError([{ ref: file, path: "", message: "the file must hold a JSON object: put {} in it, or fix it by hand" }]);
  return data;
}

function place(document: Json, segments: string[], value: unknown, file: string): void {
  let node = document;
  for (const [depth, segment] of segments.slice(0, -1).entries()) {
    const next = Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (isRecord(next)) {
      node = next;
    } else if (next === undefined) {
      const created: Json = {};
      define(node, segment, created);
      node = created;
    } else {
      throw new ConfigError([{ ref: file, path: pointerOf(...segments.slice(0, depth + 1)), message: "is not an object, so nothing can be set below it: set that name to an object first, or pick another path" }]);
    }
  }
  define(node, segments.at(-1)!, value);
}

function otherLayer(request: ConfigSetRequest): LoadedConfig | undefined {
  try {
    return loadConfigFile(SCOPES[request.scope].otherFile(request.cwd));
  } catch (err) {
    if (err instanceof ConfigError) return undefined;
    throw err;
  }
}

function declaredNameIssues(request: ConfigSetRequest, file: string, candidate: ConfigFile): ConfigIssue[] {
  const other = otherLayer(request);
  const written: LoadedConfig = { path: file, data: candidate };
  const layers = request.scope === "global" ? { global: written, repo: other } : { global: other, repo: written };
  const issues = new Map<string, ConfigIssue>();
  for (const workflow of request.workflows) {
    try {
      resolveConfig({ workflow, ...layers, env: {} });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      for (const issue of err.issues.filter((i) => i.ref === file)) issues.set(`${issue.path}|${issue.message}`, issue);
    }
  }
  return [...issues.values()];
}

export function setConfigValue(request: ConfigSetRequest): ConfigSetResult {
  const segments = segmentsOf(request.path);
  if (segments.some((segment) => segment === "")) {
    throw new ConfigError([{ ref: COMMAND, path: "", message: `"${request.path}" is not a dotted path: use names joined by "." (write "\\." for a "." inside a name)` }]);
  }
  const { dirMode, fileMode } = SCOPES[request.scope];
  const file = SCOPES[request.scope].file(request.cwd);
  const document = readDocument(file);
  const value = valueOf(request.value);
  place(document, segments, value, file);

  const schemaIssues = validateConfigData(document).map((problem): ConfigIssue => ({ ref: file, ...problem }));
  if (schemaIssues.length) throw new ConfigError(schemaIssues);
  const nameIssues = declaredNameIssues(request, file, document as ConfigFile);
  if (nameIssues.length) throw new ConfigError(nameIssues);

  mkdirSync(dirname(file), { recursive: true, mode: dirMode });
  writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`, fileMode);
  return { file, scope: request.scope, path: request.path, value };
}
