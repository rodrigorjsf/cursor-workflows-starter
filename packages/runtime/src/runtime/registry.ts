// Descobre workflows e os carrega por nome. Ordem (o último vence em caso de nome repetido):
//   1. <kit>/workflows/              — workflows que vêm com o kit
//   2. <repo>/.agents/workflows/     — workflows do repositório alvo (local neutro, não ligado a um harness)
//   3. $WORKFLOWS_DIR                — override explícito
// Mesma ideia do Claude Code (.claude/workflows/ do projeto vence ~/.claude/workflows/), num local
// que Cursor, Claude Code e Codex enxergam igualmente: o runtime é nosso, não de um harness.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "./parse-json.js";
import type { WorkflowDefinition } from "./workflow.js";
import { recordWorkflowSource } from "./workflow-source.js";

export function workflowDirs(cwd: string): string[] {
  const dirs = [resolve(import.meta.dirname, "..", "..", "workflows"), join(cwd, ".agents", "workflows")];
  if (process.env.WORKFLOWS_DIR) dirs.push(resolve(process.env.WORKFLOWS_DIR));
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

/** Does the object name itself: a `meta.name` that is a non-empty string? */
const hasName = (value: Record<string, unknown>): boolean => isRecord(value.meta) && typeof value.meta.name === "string" && value.meta.name !== "";

/**
 * Is `value` a workflow definition? A workflow file is code the kit imports without a type check, so what its default export
 * holds is checked at load: the two members every caller relies on, the name (the key of the registry, and of `wf run <name>`)
 * and `run`. The rest of the shape is validated where it is used: the args against `meta.argsSchema`, the roles and settings by
 * the config layers.
 */
const isWorkflowDefinition = (value: unknown): value is WorkflowDefinition => isRecord(value) && hasName(value) && typeof value.run === "function";

/** Why `value`, which failed `isWorkflowDefinition`, is not a workflow: the first member that is wrong. */
function whyNotWorkflow(value: unknown): string {
  const lead = "the default export is not a workflow definition";
  if (!isRecord(value)) return `${lead}: expected an object, got ${value === null ? "null" : typeof value}`;
  if (!hasName(value)) return `${lead}: meta.name must be a non-empty string`;
  return `${lead}: run must be a function`;
}

/** A workflow file that failed to load: its path and why. */
export interface BrokenWorkflow {
  file: string;
  error: string;
}

export interface DiscoverOptions {
  /**
   * Load a file again when it changed since this process last imported it. A process that lives for days (the dashboard) would
   * otherwise keep listing, and checking args against, the workflow as it was first imported: Node caches a module by its URL.
   * The URL then carries the file's modification time and size, so an unchanged file is not imported twice. Only the file itself
   * is loaded again, not the modules it imports.
   */
  fresh?: boolean;
}

/** Loads every workflow it can. A file that fails to import is collected in `broken` instead of aborting the rest. */
export async function discoverWorkflows(
  cwd: string,
  { fresh = false }: DiscoverOptions = {},
): Promise<{ workflows: Map<string, WorkflowDefinition>; broken: BrokenWorkflow[] }> {
  const workflows = new Map<string, WorkflowDefinition>();
  const broken: BrokenWorkflow[] = [];
  for (const dir of workflowDirs(cwd)) {
    for (const file of readdirSync(dir).sort()) {
      if (!/\.(ts|js|mjs)$/.test(file) || file.endsWith(".d.ts")) continue;
      const path = join(dir, file);
      try {
        const { mtimeMs, size } = fresh ? statSync(path) : { mtimeMs: 0, size: 0 };
        const mod: unknown = await import(pathToFileURL(path).href + (fresh ? `?v=${mtimeMs}-${size}` : ""));
        const def = isRecord(mod) ? mod.default : undefined;
        if (def === undefined) continue; // no default export: a module the workflows import, not a workflow
        if (!isWorkflowDefinition(def)) {
          broken.push({ file: path, error: whyNotWorkflow(def) });
          continue;
        }
        recordWorkflowSource(def, path);
        workflows.set(def.meta.name, def);
      } catch (err) {
        broken.push({ file: path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { workflows, broken };
}

/** Loads every workflow, and throws on the first broken file: for callers that must not run with a partial set. */
export async function loadWorkflows(cwd: string): Promise<Map<string, WorkflowDefinition>> {
  const { workflows, broken } = await discoverWorkflows(cwd);
  if (broken.length) throw new Error(broken.map((b) => `${b.file}: ${b.error}`).join("\n"));
  return workflows;
}
