// Config: layered JSON config with global hard caps and named roles. `loadEffectiveConfig` reads the two files, the env
// and the overrides afresh on every call (a run start, a `start_workflow`, `wf config show`): nothing is cached.

import type { WorkflowDefinition } from "../runtime/workflow.js";
import { ConfigError, type ConfigIssue, type LoadedConfig, globalConfigPath, loadConfigFile, repoConfigPath } from "./file.js";
import { type FlagLimits, type LimitOverrides, type ResolvedConfig, resolveConfig } from "./resolve.js";

export { ConfigError, CONFIG_SCHEMA_PATH, globalConfigPath, repoConfigPath } from "./file.js";
export { LIMIT_FIELDS, STEP_OVERRIDE_FIELDS, allowedSources, isModelAllowed, type FlagLimits, type LimitOverrides, type ResolvedConfig, type StepOverrides } from "./resolve.js";

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
