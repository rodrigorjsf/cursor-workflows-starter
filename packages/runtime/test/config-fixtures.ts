// Shared by the config tests: writes the two config files into the throwaway home and the temp repo, and sets env vars
// for the length of one callback.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

type RunStart = Extract<WorkflowEvent, { type: "run-start" }>;

export const globalConfigPath = () => join(process.env.WF_HOME!, "config.json");
export const repoConfigPath = (cwd: string) => join(cwd, ".agents", "workflows", "config.json");

const write = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
};
export const writeGlobalConfig = (content: unknown) => write(globalConfigPath(), content);
export const writeRepoConfig = (cwd: string, content: unknown) => write(repoConfigPath(cwd), content);
export const clearConfig = (cwd: string) => {
  rmSync(globalConfigPath(), { force: true });
  rmSync(join(cwd, ".agents"), { recursive: true, force: true });
};

/** Sets env vars for the callback and restores them after (tests of one file run one after the other). */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

export const runStartOf = (events: WorkflowEvent[]): RunStart => events.find((e): e is RunStart => e.type === "run-start")!;

/** A workflow with three roles, a budget and code defaults: the subject of most config tests. */
export const configWorkflow = (run: Parameters<typeof defineWorkflow>[0]["run"] = (ctx) => ctx.agent("p", { role: "classify", label: "c" })) =>
  defineWorkflow({
    meta: {
      name: "cfg",
      description: "config test workflow",
      roles: [
        { name: "classify", cloud: "ok", defaults: { model: { id: "composer-2.5" } } },
        { name: "review", cloud: "read-only", defaults: { model: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] }, settingSources: [] } },
        { name: "implement.low", cloud: "never", envAliases: ["LOW"], defaults: { model: { id: "composer-2.5" } } },
      ],
    },
    defaults: { model: { id: "fallback-model" }, timeoutMs: 1_800_000, retries: 1, schemaRetries: 2 },
    budget: { maxTokens: 3_000_000 },
    run,
  });
