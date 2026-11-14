// Child process of run-lock.test.ts: starts a run whose only step never ends, says so on stdout, and stays until killed.
// Usage: hold-run.ts <cwd> <runId>
process.env.WF_METRICS = "off";
import { script } from "./fake-sdk.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const [cwd, runId] = process.argv.slice(2) as [string, string];
script.push(() => ({ hang: true }));
const held = defineWorkflow({
  meta: { name: "held", description: "a run that never finishes" },
  defaults: { model: { id: "m" } },
  run: (ctx) => ctx.agent("hold", { label: "hold", retries: 0, timeoutMs: 10 * 60_000 }),
});
await runWorkflow(held, {}, { cwd, runId, onEvent: (e) => e.type === "step-start" && process.stdout.write("started\n") });
