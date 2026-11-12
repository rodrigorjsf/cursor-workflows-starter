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

export interface ResolveInput {
  workflow: Pick<WorkflowDefinition, "meta" | "defaults" | "budget">;
  global?: LoadedConfig;
  repo?: LoadedConfig;
  env: Record<string, string | undefined>;
  /** CLI flags and options of whoever embeds the engine: trusted, clamped by the caps. */
  flags?: LimitOverrides;
  /** The chat's overrides (`start_workflow`): they can only tighten what the other layers resolved. */
  tighten?: LimitOverrides;
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
const ROLE_FIELDS = ["timeoutMs", "retries", "schemaRetries", "maxTokensPerStep", "settingSources"] as const;
const LIMIT_FIELDS = ["maxTokens", "maxTokensPerStep", "maxCents", "concurrency"] as const;
const lastSegment = (pointer: Pointer): string => pointer.slice(pointer.lastIndexOf("/") + 1);

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
  for (const [name, field, integer] of [["WF_MAX_TOKENS", "maxTokens", true], ["WF_MAX_CENTS", "maxCents", false]] as const) {
    const raw = input.env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
      issues.push({ ref: name, path: "", message: `esperava um número ${integer ? "inteiro " : ""}maior ou igual a 0, recebeu "${raw}"` });
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
    for (const field of ["id", "params", "maxMode"] as const) {
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
  for (const field of ["id", "params", "maxMode"] as const) {
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

function flagEntries(flags: LimitOverrides | undefined): Entry[] {
  return LIMIT_FIELDS.flatMap((field) => {
    const value = flags?.[field];
    if (value === undefined) return [];
    const ref = FLAG_REF[field] ?? `RunOptions.${field}`;
    return [{ layer: "flag" as const, ref, path: ref, at: pointerOf("limits", field), value }];
  });
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
    ...flagEntries(input.flags),
  ];
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
    for (const field of ["id", "params", "maxMode"] as const) {
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

  // The chat can only tighten what the other layers resolved (cap included).
  const clampNumber = (value: number | null, cap: number | null): number | null => (cap === null ? value : value === null ? cap : Math.min(value, cap));
  for (const field of LIMIT_FIELDS) {
    const value = input.tighten?.[field];
    if (value === undefined) continue;
    const at = pointerOf("limits", field);
    const current = clampNumber(cells.get(at)!.value as number | null, capOf.get(field) ?? null);
    const looser = current !== null && (value === null || value > current);
    if (looser) {
      violations.push({
        layer: "mcp",
        ref: "start_workflow.overrides",
        path: field,
        requested: value,
        applied: current,
        message: `${field} ${value === null ? "null (sem limite)" : value} afrouxaria o valor em vigor (${current}): o override do chat só pode apertar; ignorado`,
      });
    } else {
      set(at, value, { layer: "mcp", ref: "start_workflow.overrides" });
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

  const roleOf = (base: Pointer): EffectiveRole => {
    const role: EffectiveRole = {};
    const model: Partial<ModelSelection> = {};
    for (const field of ["id", "params", "maxMode"] as const) {
      const cell = cells.get(`${base}/model/${field}`);
      if (cell) Object.assign(model, { [field]: cell.value });
    }
    if (Object.keys(model).length) role.model = model;
    for (const field of ROLE_FIELDS) {
      const cell = cells.get(`${base}/${field}`);
      if (cell) Object.assign(role, { [field]: cell.value });
    }
    return role;
  };
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
    roles: Object.fromEntries(roles.map((r) => [r.name, roleOf(pointerOf("roles", r.name))])),
    labels: Object.fromEntries([...labels].map((glob) => [glob, roleOf(pointerOf("labels", glob))])),
  };

  return {
    config,
    provenance: Object.fromEntries([...cells].map(([at, cell]) => [at, cell.source])),
    violations,
    stepOverrides(role, label) {
      const best = role === undefined ? [...labels].filter((g) => globMatches(g, label)).sort((a, b) => literalLength(b) - literalLength(a))[0] : undefined;
      const base = role !== undefined ? pointerOf("roles", role) : best !== undefined ? pointerOf("labels", best) : undefined;
      const overrides: StepOverrides = { maxTokensPerStep: config.limits.maxTokensPerStep };
      if (base === undefined) return overrides;
      const layered = (at: Pointer): Cell | undefined => {
        const cell = cells.get(at);
        return cell && cell.source.layer !== "default" ? cell : undefined;
      };
      const model: Partial<ModelSelection> = {};
      for (const field of ["id", "params", "maxMode"] as const) {
        const cell = layered(`${base}/model/${field}`);
        if (cell) Object.assign(model, { [field]: cell.value });
      }
      if (Object.keys(model).length) overrides.model = model;
      for (const field of ["timeoutMs", "retries", "schemaRetries", "settingSources"] as const) {
        const cell = layered(`${base}/${field}`);
        if (cell) Object.assign(overrides, { [field]: cell.value });
      }
      const perStep = cells.get(`${base}/maxTokensPerStep`);
      if (perStep) overrides.maxTokensPerStep = perStep.value as number | null;
      return overrides;
    },
  };
}
