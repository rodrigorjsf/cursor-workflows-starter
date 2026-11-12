// Descobre workflows e os carrega por nome. Ordem (o último vence em caso de nome repetido):
//   1. <kit>/workflows/              — workflows que vêm com o kit
//   2. <repo>/.agents/workflows/     — workflows do repositório alvo (local neutro, não ligado a um harness)
//   3. $WORKFLOWS_DIR                — override explícito
// Mesma ideia do Claude Code (.claude/workflows/ do projeto vence ~/.claude/workflows/), num local
// que Cursor, Claude Code e Codex enxergam igualmente: o runtime é nosso, não de um harness.

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkflowDefinition } from "./workflow.js";

export function workflowDirs(cwd: string): string[] {
  const dirs = [resolve(import.meta.dirname, "..", "..", "workflows"), join(cwd, ".agents", "workflows")];
  if (process.env.WORKFLOWS_DIR) dirs.push(resolve(process.env.WORKFLOWS_DIR));
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

/** A workflow file that failed to load: its path and why. */
export interface BrokenWorkflow {
  file: string;
  error: string;
}

/** Loads every workflow it can. A file that fails to import is collected in `broken` instead of aborting the rest. */
export async function discoverWorkflows(
  cwd: string,
): Promise<{ workflows: Map<string, WorkflowDefinition<any, any>>; broken: BrokenWorkflow[] }> {
  const workflows = new Map<string, WorkflowDefinition<any, any>>();
  const broken: BrokenWorkflow[] = [];
  for (const dir of workflowDirs(cwd)) {
    for (const file of readdirSync(dir).sort()) {
      if (!/\.(ts|js|mjs)$/.test(file) || file.endsWith(".d.ts")) continue;
      const path = join(dir, file);
      try {
        const mod = (await import(pathToFileURL(path).href)) as { default?: WorkflowDefinition<any, any> };
        if (mod.default?.meta?.name) workflows.set(mod.default.meta.name, mod.default);
      } catch (err) {
        broken.push({ file: path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { workflows, broken };
}

/** Loads every workflow, and throws on the first broken file: for callers that must not run with a partial set. */
export async function loadWorkflows(cwd: string): Promise<Map<string, WorkflowDefinition<any, any>>> {
  const { workflows, broken } = await discoverWorkflows(cwd);
  if (broken.length) throw new Error(broken.map((b) => `${b.file}: ${b.error}`).join("\n"));
  return workflows;
}
