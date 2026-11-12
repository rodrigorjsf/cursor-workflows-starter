// ConfigResolver: folds the layers into the effective config of one workflow, with the provenance of every value and
// the violations. Pure: it reads nothing from disk or the process (callers pass the loaded files and the env).
//
// Precedence: code defaults < global file < repo file < env < flag < MCP override. The global caps then clamp the
// result (numbers take the minimum, allowlists intersect). A `null` disables a limit, an absent key inherits.
// Everything is keyed by JSON pointers into the effective config (`/limits/maxTokens`, `/roles/review/model/id`),
// which is also how the provenance is keyed.

import type { ModelSelection, SettingSource } from "@cursor/sdk";
import type { ConfigSource, ConfigViolation, EffectiveCaps, EffectiveConfig, EffectiveRole } from "../runtime/events.js";
import type { WorkflowDefinition, WorkflowRole } from "../runtime/workflow.js";
import { globMatches, literalLength } from "./glob.js";
import { ConfigError, type ConfigIssue, type LoadedConfig, type Pointer, type RolePrefs, type WorkflowPrefs, pointerOf } from "./file.js";

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
export const LIMIT_FIELDS = ["maxTokens", "maxTokensPerStep", "maxCents", "concurrency"] as const;
const MODEL_FIELDS = ["id", "params", "maxMode"] as const;
/** The step settings the config layers override on top of a call's own options. */
export const STEP_OVERRIDE_FIELDS = ["timeoutMs", "retries", "schemaRetries", "settingSources"] as const;
const ROLE_FIELDS = [...STEP_OVERRIDE_FIELDS, "maxTokensPerStep"] as const;
const lastSegment = (pointer: Pointer): string => pointer.slice(pointer.lastIndexOf("/") + 1);

/** Why a value is not a valid limit, or undefined when it is. `null` means no limit, which concurrency cannot have. */
function limitProblem(field: (typeof LIMIT_FIELDS)[number], value: unknown): string | undefined {
  if (value === null) return field === "concurrency" ? "concurrency não pode ser null" : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return "esperava um número";
  const min = field === "concurrency" ? 1 : 0;
  if (value < min) return `esperava um número maior ou igual a ${min}`;
  if (field !== "maxCents" && !Number.isInteger(value)) return "esperava um número inteiro";
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
      issues.push({ ref: name, path: "", message: `${problem}, recebeu "${raw}"` });
      continue;
    }
    entries.push({ layer: "env", ref: name, path: name, at: pointerOf("limits", field), value });
  }
  for (const role of roles) {
    const name = modelEnvNames(role).find((n) => input.env[n]?.trim());
    if (!name) continue;
    const model = parseModelSpec(input.env[name]!);
    if (!model) {
      issues.push({ ref: name, path: "", message: `modelo inválido "${input.env[name]}": use <id> ou <id>[param=valor,...]` });
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
  const prefs: WorkflowPrefs | undefined = file.data.workflows?.[workflow];
  if (!prefs) return [];
  const base = pointerOf("workflows", workflow);
  const entries: Entry[] = [];
  for (const field of LIMIT_FIELDS) {
    if (prefs[field] !== undefined) entries.push({ layer, ref: file.path, path: `${base}/${field}`, at: pointerOf("limits", field), value: prefs[field] });
  }
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
    if (problem) issues.push({ ref, path: "", message: `${problem}, recebeu ${JSON.stringify(value)}` });
    else entries.push({ layer: "flag", ref, path: ref, at: pointerOf("limits", field), value });
  }
  return entries;
}

const MCP_OVERRIDES_REF = "start_workflow.overrides";

function checkMcpOverrides(overrides: LimitOverrides | undefined, issues: ConfigIssue[]): void {
  for (const field of LIMIT_FIELDS) {
    const value = overrides?.[field];
    const problem = value === undefined ? undefined : limitProblem(field, value);
    if (problem) issues.push({ ref: MCP_OVERRIDES_REF, path: field, message: `${problem}, recebeu ${JSON.stringify(value)}` });
  }
}

function checkRoleNames(input: ResolveInput, declared: string[], issues: ConfigIssue[]): void {
  const name = input.workflow.meta.name;
  for (const file of [input.global, input.repo]) {
    for (const role of Object.keys(file?.data.workflows?.[name]?.roles ?? {})) {
      if (declared.includes(role)) continue;
      const known = declared.length ? `o workflow ${name} declara: ${declared.join(", ")}` : `o workflow ${name} não declara papéis`;
      issues.push({ ref: file!.path, path: pointerOf("workflows", name, "roles", role), message: `papel desconhecido (${known})` });
    }
  }
}

export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const { meta, defaults, budget } = input.workflow;
  const roles = meta.roles ?? [];
  const issues: ConfigIssue[] = [];
  checkRoleNames(input, roles.map((r) => r.name), issues);
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
    allowedLocations: rawCaps.allowedLocations ?? null,
    maxConcurrency: rawCaps.maxConcurrency ?? null,
  };
  /** The numeric cap of each limit field; `settingSources` and model ids have their own checks. */
  const capOf = new Map<string, number | null>([
    ["maxTokens", caps.maxTokens],
    ["maxTokensPerStep", caps.maxTokensPerStep],
    ["maxCents", caps.maxCents],
    ["concurrency", caps.maxConcurrency],
  ]);
  const capRef = input.global?.path;

  const violations: ConfigViolation[] = [];
  const cells = new Map<Pointer, Cell>();
  const set = (at: Pointer, value: unknown, source: ConfigSource) => cells.set(at, { value, source });

  // Code defaults: the engine's, the workflow's, then each role's own.
  const fromCode: ConfigSource = { layer: "default" };
  set(pointerOf("limits", "maxTokens"), budget?.maxTokens ?? null, fromCode);
  set(pointerOf("limits", "maxTokensPerStep"), null, fromCode);
  set(pointerOf("limits", "maxCents"), budget?.maxCents ?? null, fromCode);
  set(pointerOf("limits", "concurrency"), DEFAULT_CONCURRENCY, fromCode);
  for (const role of roles) {
    const code = { ...defaults, ...role.defaults };
    for (const field of MODEL_FIELDS) {
      if (code.model?.[field] !== undefined) set(pointerOf("roles", role.name, "model", field), code.model[field], fromCode);
    }
    for (const field of ["timeoutMs", "retries", "schemaRetries"] as const) {
      if (code[field] !== undefined) set(pointerOf("roles", role.name, field), code[field], fromCode);
    }
    if (role.defaults?.settingSources) set(pointerOf("roles", role.name, "settingSources"), role.defaults.settingSources, fromCode);
  }

  if (input.repo?.data.caps) {
    violations.push({
      layer: "repo",
      ref: input.repo.path,
      path: "/caps",
      requested: input.repo.data.caps,
      applied: caps,
      message: "os tetos (caps) só valem no arquivo global: o do repositório pode apertar tetos pelas preferências, nunca afrouxar; ignorado",
    });
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
      violate(cap, `${field} ${entry.value === null ? "null (sem limite)" : entry.value} passa do teto global ${cap}: vale o teto`);
    }
    if (field === "settingSources" && caps.allowedSettingSources) {
      const refused = (entry.value as SettingSource[]).filter((s) => !caps.allowedSettingSources!.includes(s));
      if (refused.length) violate(allowedSources(caps.allowedSettingSources, entry.value as SettingSource[]), `settingSources ${refused.join(", ")} fora do teto allowedSettingSources: removido(s)`);
    }
    if (entry.at.endsWith("/model/id") && !isModelAllowed(caps.allowedModels, entry.value as string)) {
      violate(undefined, `o modelo ${entry.value} não está em allowedModels: o modelo pedido não tem efeito`);
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
        message: `${field} ${value === null ? "null (sem limite)" : value} afrouxaria o valor em vigor (${current}): o override do chat só pode apertar; ignorado`,
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
        message: `o modelo ${id}, padrão do código do papel ${role.name}, não está em allowedModels: as etapas desse papel falham até a config ou WF_MODEL_${role.name.toUpperCase().replace(/[.-]/g, "_")} trocar o modelo`,
      });
    }
  }
  const limit = (field: (typeof LIMIT_FIELDS)[number]) => cells.get(pointerOf("limits", field))!.value;
  const config: EffectiveConfig = {
    workflow: meta.name,
    limits: {
      maxTokens: limit("maxTokens") as number | null,
      maxTokensPerStep: limit("maxTokensPerStep") as number | null,
      maxCents: limit("maxCents") as number | null,
      concurrency: limit("concurrency") as number,
    },
    caps,
    roles: Object.fromEntries(roles.map((r) => [r.name, settingsOf(pointerOf("roles", r.name))])),
    labels: Object.fromEntries([...labels].map((glob) => [glob, settingsOf(pointerOf("labels", glob))])),
  };

  return {
    config,
    provenance: Object.fromEntries([...cells].map(([at, cell]) => [at, cell.source])),
    violations,
    stepOverrides(role, label) {
      const best = role === undefined ? [...labels].filter((g) => globMatches(g, label)).sort((a, b) => literalLength(b) - literalLength(a))[0] : undefined;
      const base = role !== undefined ? pointerOf("roles", role) : best !== undefined ? pointerOf("labels", best) : undefined;
      if (base === undefined) return { maxTokensPerStep: config.limits.maxTokensPerStep };
      const { maxTokensPerStep, ...layered } = settingsOf(base, (cell) => cell.source.layer !== "default");
      return { ...layered, maxTokensPerStep: maxTokensPerStep === undefined ? config.limits.maxTokensPerStep : maxTokensPerStep };
    },
  };
}
