// The two config files (global `~/.cursor-workflows/config.json`, repo `.agents/workflows/config.json`): their types,
// the shipped JSON Schema that validates both, and the loader. Validation errors name the field path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSelection, SettingSource } from "@cursor/sdk";
import { Ajv, type ValidateFunction } from "ajv";
import type { StepLocation } from "../runtime/backend.js";
import { userDir } from "../runtime/state.js";

/** Pointer into a JSON document (RFC 6901): `/workflows/implement-issue/roles/review`. */
export type Pointer = string;

export const escapePointer = (segment: string): string => segment.replace(/~/g, "~0").replace(/\//g, "~1");
export const pointerOf = (...segments: string[]): Pointer => segments.map((s) => `/${escapePointer(s)}`).join("");

export interface ConfigCaps {
  maxTokens?: number | null;
  maxTokensPerStep?: number | null;
  maxCents?: number | null;
  allowedModels?: string[] | null;
  allowedSettingSources?: SettingSource[] | null;
  allowedLocations?: StepLocation[] | null;
  maxConcurrency?: number | null;
  requireSandbox?: boolean | null;
}

export interface RolePrefs {
  /** Where the role's steps run. Absent: `local`. Only roles have one (a label has no declared cloud capability). */
  location?: StepLocation;
  /** Field by field: what is absent inherits from the layer below. */
  model?: Partial<ModelSelection>;
  timeoutMs?: number;
  retries?: number;
  schemaRetries?: number;
  maxTokensPerStep?: number | null;
  settingSources?: SettingSource[];
}

export interface WorkflowPrefs {
  maxTokens?: number | null;
  maxTokensPerStep?: number | null;
  maxCents?: number | null;
  concurrency?: number;
  execTimeoutMs?: number;
  /** The workflow's own settings (its `meta.settings`), by name. The schema validates the ones the kit ships. */
  settings?: Record<string, unknown>;
  roles?: Record<string, RolePrefs>;
  labels?: Record<string, RolePrefs>;
}

export interface DashboardPrefs {
  /** `false` keeps `start_workflow` from starting the dashboard. */
  autoStart?: boolean;
}

export interface CloudPrefs {
  /** The git remote that cloud steps' snapshot branches are pushed to. Default: `origin`. */
  remote?: string;
}

export interface ConfigFile {
  kit?: string;
  caps?: ConfigCaps;
  dashboard?: DashboardPrefs;
  cloud?: CloudPrefs;
  workflows?: Record<string, WorkflowPrefs>;
}

/** A config file that was read and validated. */
export interface LoadedConfig {
  path: string;
  data: ConfigFile;
}

export interface ConfigIssue {
  /** The file, the env var or the option the problem is in. */
  ref: string;
  /** Where in it: a JSON pointer for files, `""` for a file that does not parse. */
  path: string;
  message: string;
}

/** Thrown when a config layer cannot be used. `message` lists every issue, each with its file and field path. */
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`invalid configuration:\n${issues.map((i) => `  ${i.ref}${i.path ? ` ${i.path}` : ""}: ${i.message}`).join("\n")}`);
  }
}

/** The JSON Schema file. It ships inside the runtime package, next to `src/`: found from this module, never from the repo root. */
export const CONFIG_SCHEMA_PATH = join(import.meta.dirname, "..", "..", "schema", "config.schema.json");

let validator: ValidateFunction | undefined;
function schemaValidator(): ValidateFunction {
  validator ??= new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(CONFIG_SCHEMA_PATH, "utf8")));
  return validator;
}

/** Ajv errors as `{path, message}` with the path to the offending field (an unknown key or role name is named in the path). */
export function validateConfigData(data: unknown): Array<{ path: Pointer; message: string }> {
  const validate = schemaValidator();
  if (validate(data)) return [];
  return (validate.errors ?? [])
    .filter((e) => e.keyword !== "propertyNames") // the wrapper of the pattern error that names the key
    .map((e) => {
      if (e.keyword === "additionalProperties") {
        return { path: `${e.instancePath}/${escapePointer(String((e.params as { additionalProperty: string }).additionalProperty))}`, message: "chave desconhecida" };
      }
      const name = e.propertyName === undefined ? "" : `/${escapePointer(e.propertyName)}`;
      return { path: `${e.instancePath}${name}`, message: e.message ?? "invalid" };
    });
}

/** Reads and validates one config file. A missing file is `undefined`; one that does not parse or validate throws `ConfigError`. */
export function loadConfigFile(path: string): LoadedConfig | undefined {
  if (!existsSync(path)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError([{ ref: path, path: "", message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }]);
  }
  const errors = validateConfigData(data);
  if (errors.length) throw new ConfigError(errors.map((e) => ({ ref: path, ...e })));
  return { path, data: data as ConfigFile };
}

export const globalConfigPath = (): string => join(userDir(), "config.json");
/** The repo config, relative to the repo root. */
export const REPO_CONFIG_FILE = join(".agents", "workflows", "config.json");
export const repoConfigPath = (cwd: string): string => join(cwd, REPO_CONFIG_FILE);
