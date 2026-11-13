// ConfigResolver: folds the layers into the effective config of one workflow, with the provenance of every value and
// the violations. Pure: it reads nothing from disk or the process (callers pass the loaded files and the env).
//
// Precedence: code defaults < global file < repo file < env < flag < MCP override. The global caps then clamp the
// result (numbers take the minimum, allowlists intersect). A `null` disables a limit, an absent key inherits.
// Everything is keyed by JSON pointers into the effective config (`/limits/maxTokens`, `/roles/review/model/id`),
// which is also how the provenance is keyed.

import type { ModelSelection, SettingSource } from "@cursor/sdk";
import type { ResultVia, StepLocation } from "../runtime/backend.js";
import type { ConfigSource, ConfigViolation, EffectiveCaps, EffectiveConfig, EffectiveLimits, EffectiveRole } from "../runtime/events.js";
import type { ForgeName, WorkflowDefinition, WorkflowRole } from "../runtime/workflow.js";
import { globMatches, literalLength } from "./glob.js";
import { bareHost, ConfigError, type ConfigIssue, FORGE_TITLES, type LoadedConfig, knownForgeOf, type Pointer, type RolePrefs, type WorkflowPrefs, pointerOf } from "./file.js";

/** The per-run limits a flag or an MCP caller can set. */
export interface LimitOverrides {
  maxTokens?: number | null;
  maxTokensPerStep?: number | null;
  maxCents?: number | null;
  concurrency?: number;
}

/** What the flag layer can set: there is no per-step flag. */
export type FlagLimits = Pick<LimitOverrides, "maxTokens" | "maxCents" | "concurrency">;

export interface ResolveInput {
  workflow: Pick<WorkflowDefinition, "meta" | "defaults" | "budget">;
  global?: LoadedConfig;
  repo?: LoadedConfig;
  env: Record<string, string | undefined>;
  /** CLI flags and options of whoever embeds the engine: trusted, clamped by the caps. */
  flags?: FlagLimits;
  /** The chat's overrides (`start_workflow`): they can only tighten what the other layers resolved. */
  mcpOverrides?: LimitOverrides;
}

/** What the config layers change for one step. A field the layers left alone is absent: the call's own options stand. */
export interface StepOverrides {
  /** Where the step runs: its role's location, once the global `allowedLocations` cap has been applied. Always `local` for a step without a role. */
  location: StepLocation;
  /** How a cloud step delivers a structured result: its role's `resultVia`. Absent: the code default (`json-block`). */
  resultVia?: ResultVia;
  model?: Partial<ModelSelection>;
  timeoutMs?: number;
  retries?: number;
  schemaRetries?: number;
  settingSources?: SettingSource[];
  /** The step's token cap: the role's (or label's), else the workflow's. Already clamped by the global cap. */
  maxTokensPerStep: number | null;
}

export interface ResolvedConfig {
  config: EffectiveConfig;
  provenance: Record<Pointer, ConfigSource>;
  violations: ConfigViolation[];
  /** The overrides for a step: of its role when it has one, else of the best-matching label glob. */
  stepOverrides(role: string | undefined, label: string): StepOverrides;
}

type Layer = "global" | "repo" | "env" | "flag";

/** One value a layer sets. `at` is where it lands in the effective config, `path` where it is in the layer's own source. */
interface Entry {
  layer: Layer;
  ref: string;
  path: string;
  at: Pointer;
  value: unknown;
  /** Entries of one model setting travel together: if its id is refused, the whole group is dropped. */
  group?: string;
  /** The label glob, for entries that configure steps by label (the raw name: `at` has it escaped). */
  label?: string;
}

interface Cell {
  value: unknown;
  source: ConfigSource;
}

const DEFAULT_CONCURRENCY = 4;
/** The git remote that cloud snapshots go to when the config names none. */
const DEFAULT_CLOUD_REMOTE = "origin";
/** How long a `ctx.exec` command may run when neither the call nor the config says: a long test run is of this order. */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
type WorkflowBudget = WorkflowDefinition["budget"];
/**
 * The per-run limits, one row each: the global cap that clamps it, its bounds, whether `null` (no limit) is allowed, its
 * code default (from the workflow's `budget`, when it has one) and how a chat override describes it. The resolver and
 * the MCP override schema read them from here; test/limits.test.ts keeps the shipped JSON Schema in step. The rows must
 * match the fields of `EffectiveLimits` (the typed, documented shape of the result): the compiler checks both ways.
 */
export const LIMITS = {
  maxTokens: { cap: "maxTokens", min: 0, integer: true, nullable: true, codeDefault: (b: WorkflowBudget) => b?.maxTokens ?? null, description: "Token cap for the run." },
  maxTokensPerStep: { cap: "maxTokensPerStep", min: 0, integer: true, nullable: true, codeDefault: () => null, description: "Token cap for each step." },
  maxCents: { cap: "maxCents", min: 0, integer: false, nullable: true, codeDefault: (b: WorkflowBudget) => b?.maxCents ?? null, description: "Cost cap for the run, in cents." },
  concurrency: { cap: "maxConcurrency", min: 1, integer: true, nullable: false, codeDefault: () => DEFAULT_CONCURRENCY, description: "Concurrent agents." },
} as const satisfies Record<
  keyof EffectiveLimits,
  { cap: keyof EffectiveCaps; min: number; integer: boolean; nullable: boolean; codeDefault: (b: WorkflowBudget) => number | null; description: string }
>;
export type LimitField = keyof typeof LIMITS;
export const LIMIT_FIELDS = Object.keys(LIMITS) as LimitField[];

/** The JSON Schema of the chat's `overrides` (MCP `start_workflow`), built from LIMITS. */
export function limitOverridesSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Tighter limits for this run only (for example a lower token cap for an experiment). Tighten-only: a value looser than the config, or than the global caps, has no effect and comes back in `violations`.",
    additionalProperties: false,
    properties: Object.fromEntries(
      LIMIT_FIELDS.map((f) => [f, { type: LIMITS[f].integer ? "integer" : "number", minimum: LIMITS[f].min, description: LIMITS[f].description }]),
    ),
  };
}
const MODEL_FIELDS = ["id", "params", "maxMode"] as const;
/** The step settings the config layers override on top of a call's own options. */
export const STEP_OVERRIDE_FIELDS = ["timeoutMs", "retries", "schemaRetries", "settingSources"] as const;
const ROLE_FIELDS = [...STEP_OVERRIDE_FIELDS, "maxTokensPerStep", "location", "resultVia"] as const;
const lastSegment = (pointer: Pointer): string => pointer.slice(pointer.lastIndexOf("/") + 1);

/** Why a value is not a valid limit, or undefined when it is. `null` means no limit, which concurrency cannot have. */
function limitProblem(field: LimitField, value: unknown): string | undefined {
  const { min, integer, nullable } = LIMITS[field];
  if (value === null) return nullable ? undefined : `${field} cannot be null`;
  if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
  if (value < min) return `expected a number greater than or equal to ${min}`;
  if (integer && !Number.isInteger(value)) return "expected an integer";
  return undefined;
}

export function isModelAllowed(allowed: string[] | null, id: string): boolean {
  return allowed === null || allowed.some((glob) => globMatches(glob, id));
}

/** The sources a step may load: the intersection with the cap, in the order asked. */
export function allowedSources(allowed: SettingSource[] | null | undefined, sources: SettingSource[]): SettingSource[] {
  return allowed ? sources.filter((s) => allowed.includes(s)) : sources;
}

/** `grok-4.7` (id only: params and max mode inherit) or `grok-4.7[reasoning_effort=high,max]` (params replace). Same notation as `modelKey`. */
export function parseModelSpec(spec: string): Partial<ModelSelection> | undefined {
  const match = /^([^[\]]+?)\s*(?:\[(.*)\])?$/.exec(spec.trim());
  if (!match) return undefined;
  const model: Partial<ModelSelection> = { id: match[1]! };
  if (match[2] === undefined) return model;
  const params: NonNullable<ModelSelection["params"]> = [];
  for (const part of match[2].split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part === "max") model.maxMode = true;
    else {
      const eq = part.indexOf("=");
      if (eq < 1) return undefined;
      params.push({ id: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() });
    }
  }
  model.params = params;
  return model;
}

/** The env var suffixes that set a role's model: the role name in upper case, then its aliases. */
function modelEnvNames(role: WorkflowRole): string[] {
  return [role.name.toUpperCase().replace(/[.-]/g, "_"), ...(role.envAliases ?? [])].map((s) => `WF_MODEL_${s}`);
}

function envEntries(input: ResolveInput, roles: WorkflowRole[], issues: ConfigIssue[]): Entry[] {
  const entries: Entry[] = [];
  for (const [name, field] of [["WF_MAX_TOKENS", "maxTokens"], ["WF_MAX_CENTS", "maxCents"]] as const) {
    const raw = input.env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    const problem = limitProblem(field, value);
    if (problem) {
      issues.push({ ref: name, path: "", message: `${problem}, got "${raw}"` });
      continue;
    }
    entries.push({ layer: "env", ref: name, path: name, at: pointerOf("limits", field), value });
  }
  for (const role of roles) {
    const name = modelEnvNames(role).find((n) => input.env[n]?.trim());
    if (!name) continue;
    const model = parseModelSpec(input.env[name]!);
    if (!model) {
      issues.push({ ref: name, path: "", message: `invalid model "${input.env[name]}": use <id> or <id>[param=value,...]` });
      continue;
    }
    for (const field of MODEL_FIELDS) {
      if (model[field] !== undefined) {
        entries.push({ layer: "env", ref: name, path: name, at: pointerOf("roles", role.name, "model", field), value: model[field], group: pointerOf("roles", role.name, "model") });
      }
    }
  }
  return entries;
}

function roleEntries(section: "roles" | "labels", name: string, prefs: RolePrefs, layer: Layer, ref: string, base: string): Entry[] {
  const entries: Entry[] = [];
  const source = base + pointerOf(section, name);
  const label = section === "labels" ? name : undefined;
  for (const field of MODEL_FIELDS) {
    const value = prefs.model?.[field];
    if (value !== undefined) {
      entries.push({ layer, ref, path: `${source}/model/${field}`, at: pointerOf(section, name, "model", field), value, group: pointerOf(section, name, "model"), label });
    }
  }
  for (const field of ROLE_FIELDS) {
    if (prefs[field] !== undefined) entries.push({ layer, ref, path: `${source}/${field}`, at: pointerOf(section, name, field), value: prefs[field], label });
  }
  return entries;
}

function fileEntries(file: LoadedConfig, layer: "global" | "repo", workflow: string): Entry[] {
  const entries: Entry[] = [];
  const remote = file.data.cloud?.remote;
  if (remote !== undefined) entries.push({ layer, ref: file.path, path: pointerOf("cloud", "remote"), at: pointerOf("cloud", "remote"), value: remote });
  const prefs: WorkflowPrefs | undefined = file.data.workflows?.[workflow];
  if (!prefs) return entries;
  const base = pointerOf("workflows", workflow);
  for (const field of LIMIT_FIELDS) {
    if (prefs[field] !== undefined) entries.push({ layer, ref: file.path, path: `${base}/${field}`, at: pointerOf("limits", field), value: prefs[field] });
  }
  if (prefs.execTimeoutMs !== undefined) entries.push({ layer, ref: file.path, path: `${base}/execTimeoutMs`, at: pointerOf("execTimeoutMs"), value: prefs.execTimeoutMs });
  for (const section of ["roles", "labels"] as const) {
    for (const [name, rolePrefs] of Object.entries(prefs[section] ?? {})) entries.push(...roleEntries(section, name, rolePrefs, layer, file.path, base));
  }
  return entries;
}

const FLAG_REF: Partial<Record<keyof LimitOverrides, string>> = { maxTokens: "--max-tokens", maxCents: "--max-cents" };

function flagEntries(flags: FlagLimits | undefined, issues: ConfigIssue[]): Entry[] {
  const entries: Entry[] = [];
  for (const field of LIMIT_FIELDS) {
    const value = (flags as LimitOverrides | undefined)?.[field];
    if (value === undefined) continue;
    const ref = FLAG_REF[field] ?? `RunOptions.${field}`;
    const problem = limitProblem(field, value);
    if (problem) issues.push({ ref, path: "", message: `${problem}, got ${JSON.stringify(value)}` });
    else entries.push({ layer: "flag", ref, path: ref, at: pointerOf("limits", field), value });
  }
  return entries;
}

const MCP_OVERRIDES_REF = "start_workflow.overrides";

function checkMcpOverrides(overrides: LimitOverrides | undefined, issues: ConfigIssue[]): void {
  for (const field of LIMIT_FIELDS) {
    const value = overrides?.[field];
    const problem = value === undefined ? undefined : limitProblem(field, value);
    if (problem) issues.push({ ref: MCP_OVERRIDES_REF, path: field, message: `${problem}, got ${JSON.stringify(value)}` });
  }
}

/** A role or a setting that a config file names and the workflow does not declare is an error: usually a typo. */
function checkDeclaredNames(input: ResolveInput, section: "roles" | "settings", noun: "role" | "setting", declared: string[], issues: ConfigIssue[]): void {
  const name = input.workflow.meta.name;
  for (const file of [input.global, input.repo]) {
    for (const key of Object.keys(file?.data.workflows?.[name]?.[section] ?? {})) {
      if (declared.includes(key)) continue;
      const known = declared.length ? `workflow ${name} declares: ${declared.join(", ")}` : `workflow ${name} declares no ${section}`;
      issues.push({ ref: file!.path, path: pointerOf("workflows", name, section, key), message: `unknown ${noun} (${known})` });
    }
  }
}

/**
 * Where a config file may send a step. A label has no cloud capability, so only roles have a location; and a role the
 * workflow declares `cloud: never` cannot end up in the cloud: the last file that sets its location decides where it goes.
 * (The `read-only` capability depends on what a step does, which only the engine sees: it is checked there.)
 */
function checkLocations(input: ResolveInput, roles: WorkflowRole[], issues: ConfigIssue[]): void {
  const name = input.workflow.meta.name;
  const files = [input.global, input.repo].filter((f): f is LoadedConfig => f !== undefined);
  const prefsOf = (file: LoadedConfig) => file.data.workflows?.[name];
  for (const file of files) {
    for (const [glob, prefs] of Object.entries(prefsOf(file)?.labels ?? {})) {
      for (const field of ["location", "resultVia"] as const) {
        if (prefs[field] === undefined) continue;
        issues.push({ ref: file.path, path: pointerOf("workflows", name, "labels", glob, field), message: `${field} is set per role: a label has no cloud capability declared by the workflow, so its steps never run in the cloud` });
      }
    }
  }
  for (const role of roles.filter((r) => r.cloud === "never")) {
    const deciding = files.filter((f) => prefsOf(f)?.roles?.[role.name]?.location !== undefined).at(-1);
    if (deciding && prefsOf(deciding)?.roles?.[role.name]?.location === "cloud") {
      issues.push({
        ref: deciding.path,
        path: pointerOf("workflows", name, "roles", role.name, "location"),
        message: `role "${role.name}" is declared cloud: never by workflow ${name} (its steps need the local worktree): it cannot run in the cloud`,
      });
    }
  }
}

/** A `forges` entry that gives a host the kit knows (github.com, gitlab.com, on any port) the other forge would be silently ignored: it is an error instead. */
function checkForges(input: ResolveInput, issues: ConfigIssue[]): void {
  for (const file of [input.global, input.repo]) {
    for (const [host, forge] of Object.entries(file?.data.forges ?? {})) {
      const known = knownForgeOf(host);
      if (known === undefined || known === forge) continue;
      issues.push({ ref: file!.path, path: pointerOf("forges", host), message: `${bareHost(host)} is ${FORGE_TITLES[known]}, a host the kit knows, so it cannot be declared as ${forge}: remove the entry` });
    }
  }
}

export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const { meta, defaults, budget } = input.workflow;
  const roles = meta.roles ?? [];
  const issues: ConfigIssue[] = [];
  checkDeclaredNames(input, "roles", "role", roles.map((r) => r.name), issues);
  checkDeclaredNames(input, "settings", "setting", Object.keys(meta.settings ?? {}), issues);
  checkLocations(input, roles, issues);
  checkForges(input, issues);
  const entries = [
    ...(input.global ? fileEntries(input.global, "global", meta.name) : []),
    ...(input.repo ? fileEntries(input.repo, "repo", meta.name) : []),
    ...envEntries(input, roles, issues),
    ...flagEntries(input.flags, issues),
  ];
  checkMcpOverrides(input.mcpOverrides, issues);
  if (issues.length) throw new ConfigError(issues);

  const rawCaps = input.global?.data.caps ?? {};
  const caps: EffectiveCaps = {
    maxTokens: rawCaps.maxTokens ?? null,
    maxTokensPerStep: rawCaps.maxTokensPerStep ?? null,
    maxCents: rawCaps.maxCents ?? null,
    allowedModels: rawCaps.allowedModels ?? null,
    allowedSettingSources: rawCaps.allowedSettingSources ?? null,
    // Sending code to a cloud VM is the machine owner's decision: without the key, only local. An explicit `null` allows every location.
    allowedLocations: rawCaps.allowedLocations === undefined ? ["local"] : rawCaps.allowedLocations,
    maxConcurrency: rawCaps.maxConcurrency ?? null,
    requireSandbox: rawCaps.requireSandbox ?? null,
  };
  /** The numeric cap of each limit field; `settingSources` and model ids have their own checks. */
  const capOf = new Map<string, number | null>(LIMIT_FIELDS.map((f) => [f, caps[LIMITS[f].cap]]));
  const capRef = input.global?.path;
  const cloudAllowed = caps.allowedLocations === null || caps.allowedLocations.includes("cloud");

  const violations: ConfigViolation[] = [];
  const cells = new Map<Pointer, Cell>();
  const set = (at: Pointer, value: unknown, source: ConfigSource) => cells.set(at, { value, source });

  // Code defaults: the engine's, the workflow's, then each role's own.
  const fromCode: ConfigSource = { layer: "default" };
  for (const field of LIMIT_FIELDS) set(pointerOf("limits", field), LIMITS[field].codeDefault(budget), fromCode);
  set(pointerOf("execTimeoutMs"), DEFAULT_EXEC_TIMEOUT_MS, fromCode);
  set(pointerOf("cloud", "remote"), DEFAULT_CLOUD_REMOTE, fromCode);
  for (const role of roles) {
    const code = { ...defaults, ...role.defaults };
    for (const field of MODEL_FIELDS) {
      if (code.model?.[field] !== undefined) set(pointerOf("roles", role.name, "model", field), code.model[field], fromCode);
    }
    for (const field of ["timeoutMs", "retries", "schemaRetries"] as const) {
      if (code[field] !== undefined) set(pointerOf("roles", role.name, field), code[field], fromCode);
    }
    set(pointerOf("roles", role.name, "location"), "local", fromCode);
    if (role.defaults?.settingSources) set(pointerOf("roles", role.name, "settingSources"), role.defaults.settingSources, fromCode);
  }

  if (input.repo?.data.caps) {
    violations.push({
      layer: "repo",
      ref: input.repo.path,
      path: "/caps",
      requested: input.repo.data.caps,
      applied: caps,
      message: "caps apply only in the global file: the repo file can tighten caps through its preferences, never loosen them; ignored",
    });
  }

  if (input.repo?.data.dashboard) {
    violations.push({
      layer: "repo",
      ref: input.repo.path,
      path: "/dashboard",
      requested: input.repo.data.dashboard,
      applied: input.global?.data.dashboard ?? null,
      message: "the dashboard is one per user, for the runs of every repo: its settings apply only in the global file; ignored",
    });
  }

  // The workflow's own settings: the code default, then each file in turn. They live apart from `cells`, whose rules (caps,
  // chat overrides) go by the last segment of the pointer: a setting named like a limit must not meet them.
  const settings = new Map<string, Cell>(Object.entries(meta.settings ?? {}).map(([key, value]) => [key, { value, source: fromCode }]));
  for (const [layer, file] of [["global", input.global], ["repo", input.repo]] as const) {
    for (const [key, value] of Object.entries(file?.data.workflows?.[meta.name]?.settings ?? {})) settings.set(key, { value, source: { layer, ref: file!.path } });
  }

  // The forge of each host the config files declare: global, then repo, host by host. Apart from `cells`, like the settings: a
  // host is named by anyone (`location`, `concurrency`), and the rules of `cells` go by the last segment of the pointer.
  const forges = new Map<string, Cell>();
  for (const [layer, file] of [["global", input.global], ["repo", input.repo]] as const) {
    for (const [host, forge] of Object.entries(file?.data.forges ?? {})) forges.set(host, { value: forge, source: { layer, ref: file!.path } });
  }

  const dropped = new Set<string>();
  const labels = new Set<string>();
  for (const entry of entries) {
    if (entry.label !== undefined) labels.add(entry.label);
    const group = entry.group ? `${entry.ref}|${entry.group}` : undefined;
    if (group && dropped.has(group)) continue;
    const field = lastSegment(entry.at);
    const violate = (applied: unknown, message: string) =>
      violations.push({ layer: entry.layer, ref: entry.ref, path: entry.path, requested: entry.value, applied, message });
    const cap = capOf.get(field);
    if (cap != null && (entry.value === null || (entry.value as number) > cap)) {
      violate(cap, `${field} ${entry.value === null ? "null (no limit)" : entry.value} exceeds the global cap ${cap}: the cap applies`);
    }
    if (field === "settingSources" && caps.allowedSettingSources) {
      const refused = (entry.value as SettingSource[]).filter((s) => !caps.allowedSettingSources!.includes(s));
      if (refused.length) violate(allowedSources(caps.allowedSettingSources, entry.value as SettingSource[]), `settingSources ${refused.join(", ")} outside the allowedSettingSources cap: removed`);
    }
    if (field === "location" && entry.value === "cloud" && !cloudAllowed) {
      violate("local", `location cloud is outside the allowedLocations cap (${caps.allowedLocations?.join(", ") || "empty"}): the step runs locally`);
    }
    if (entry.at.endsWith("/model/id") && !isModelAllowed(caps.allowedModels, entry.value as string)) {
      violate(undefined, `model ${entry.value} is not in allowedModels: the requested model has no effect`);
      dropped.add(group!);
      continue;
    }
    set(entry.at, entry.value, { layer: entry.layer, ref: entry.ref });
  }

  // The chat can only tighten what the other layers resolved (cap included). A per-step cap it sets is a ceiling for
  // every role and label too, so those are brought down to it.
  const clampNumber = (value: number | null, cap: number | null): number | null => (cap === null ? value : value === null ? cap : Math.min(value, cap));
  const fromChat: ConfigSource = { layer: "mcp", ref: MCP_OVERRIDES_REF };
  for (const field of LIMIT_FIELDS) {
    const value = input.mcpOverrides?.[field];
    if (value === undefined) continue;
    const at = pointerOf("limits", field);
    const current = clampNumber(cells.get(at)!.value as number | null, capOf.get(field) ?? null);
    const looser = current !== null && (value === null || value > current);
    if (looser) {
      violations.push({
        layer: "mcp",
        ref: MCP_OVERRIDES_REF,
        path: field,
        requested: value,
        applied: current,
        message: `${field} ${value === null ? "null (no limit)" : value} would loosen the value in force (${current}): a chat override can only tighten; ignored`,
      });
      continue;
    }
    set(at, value, fromChat);
    if (field === "maxTokensPerStep" && value !== null) {
      for (const [otherAt, cell] of cells) {
        if (otherAt !== at && lastSegment(otherAt) === field && (cell.value === null || (cell.value as number) > value)) set(otherAt, value, fromChat);
      }
    }
  }

  // The caps clamp what is left: numbers take the minimum, source lists intersect.
  for (const [at, cell] of cells) {
    const field = lastSegment(at);
    const cap = capOf.get(field);
    if (cap != null) {
      const clamped = clampNumber(cell.value as number | null, cap);
      if (clamped !== cell.value) set(at, clamped, { layer: "cap", ref: capRef });
    } else if (field === "settingSources" && caps.allowedSettingSources) {
      const kept = allowedSources(caps.allowedSettingSources, cell.value as SettingSource[]);
      if (kept.length !== (cell.value as SettingSource[]).length) set(at, kept, { layer: "cap", ref: capRef });
    } else if (field === "location" && cell.value === "cloud" && !cloudAllowed) {
      set(at, "local", { layer: "cap", ref: capRef });
    }
  }

  /** The settings the cells hold under a role or label; `keep` filters the cells (the config layers only, for step overrides). */
  const settingsOf = (base: Pointer, keep: (cell: Cell) => boolean = () => true): EffectiveRole => {
    const settings: EffectiveRole = {};
    const model: Partial<ModelSelection> = {};
    for (const field of MODEL_FIELDS) {
      const cell = cells.get(`${base}/model/${field}`);
      if (cell && keep(cell)) Object.assign(model, { [field]: cell.value });
    }
    if (Object.keys(model).length) settings.model = model;
    for (const field of ROLE_FIELDS) {
      const cell = cells.get(`${base}/${field}`);
      if (cell && keep(cell)) Object.assign(settings, { [field]: cell.value });
    }
    return settings;
  };
  // A code-default model that the allowlist refuses is not a request, so nothing dropped it: say so up front, because
  // every step of that role will fail.
  for (const role of roles) {
    const at = pointerOf("roles", role.name, "model", "id");
    const id = cells.get(at)?.value as string | undefined;
    if (id !== undefined && !isModelAllowed(caps.allowedModels, id)) {
      violations.push({
        layer: "default",
        path: at,
        requested: id,
        applied: null,
        message: `model ${id}, the code default of role ${role.name}, is not in allowedModels: the steps of that role fail until the config or WF_MODEL_${role.name.toUpperCase().replace(/[.-]/g, "_")} changes the model`,
      });
    }
  }
  const limit = (field: LimitField) => cells.get(pointerOf("limits", field))!.value;
  const config: EffectiveConfig = {
    workflow: meta.name,
    // Every field comes from a LIMITS row, validated by limitProblem (concurrency is never null).
    limits: Object.fromEntries(LIMIT_FIELDS.map((f) => [f, limit(f)])) as unknown as EffectiveLimits,
    caps,
    roles: Object.fromEntries(roles.map((r) => [r.name, settingsOf(pointerOf("roles", r.name))])),
    labels: Object.fromEntries([...labels].map((glob) => [glob, settingsOf(pointerOf("labels", glob))])),
    execTimeoutMs: cells.get(pointerOf("execTimeoutMs"))!.value as number,
    cloud: { remote: cells.get(pointerOf("cloud", "remote"))!.value as string },
    forges: Object.fromEntries([...forges].map(([host, cell]) => [host, cell.value as ForgeName])),
    settings: Object.fromEntries([...settings].map(([key, cell]) => [key, cell.value])),
  };

  return {
    config,
    provenance: Object.fromEntries(
      [...cells, ...[...settings].map(([key, cell]) => [pointerOf("settings", key), cell] as const), ...[...forges].map(([host, cell]) => [pointerOf("forges", host), cell] as const)].map(([at, cell]) => [at, cell.source]),
    ),
    violations,
    stepOverrides(role, label) {
      const best = role === undefined ? [...labels].filter((g) => globMatches(g, label)).sort((a, b) => literalLength(b) - literalLength(a))[0] : undefined;
      const base = role !== undefined ? pointerOf("roles", role) : best !== undefined ? pointerOf("labels", best) : undefined;
      if (base === undefined) return { location: "local", maxTokensPerStep: config.limits.maxTokensPerStep };
      const { maxTokensPerStep, ...layered } = settingsOf(base, (cell) => cell.source.layer !== "default");
      const location = role === undefined ? "local" : ((cells.get(`${base}/location`)?.value as StepLocation | undefined) ?? "local");
      return { ...layered, location, maxTokensPerStep: maxTokensPerStep === undefined ? config.limits.maxTokensPerStep : maxTokensPerStep };
    },
  };
}
