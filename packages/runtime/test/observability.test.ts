// Testes offline da observabilidade (banco SQLite temporário, fake SDK): `npm test`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, costConfig, script } from "@cursor/sdk";
import { openDb } from "../src/observability/db.js";
import { exportRows, markRun, reconcile, summary, toCsv } from "../src/observability/queries.js";
import { outcomeClass } from "../src/observability/recorder.js";
import { runWorkflow } from "../src/runtime/engine.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

let dir: string;
let dbPath: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-obs-"));
  dbPath = join(dir, "home", "metrics.db");
  cwd = join(dir, "repo");
  Object.assign(costConfig, { raw: 9, charged: 7 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
});

const wf = defineWorkflow<{ n: number }>({
  meta: { name: "obs", description: "obs" },
  defaults: { model: { id: "composer-2", params: [{ id: "reasoning_effort", value: "low" }] } },
  async run(ctx) {
    ctx.metric("tier", "MED");
    const a = await ctx.agent("passo a", { label: "a" });
    await ctx.agent("passo b", { label: "b" });
    ctx.metric("tests_passed", 1);
    return { status: "done", a };
  },
});

test("grava run, tentativas, turnos, usage_runs e métricas", async () => {
  const r = await runWorkflow(wf, { n: 1 }, { cwd, metricsDb: dbPath });
  assert.equal(r.status, "finished");
  const db = await openDb(dbPath);
  const run = db.prepare("SELECT * FROM runs").get() as Record<string, unknown>;
  assert.equal(run.workflow, "obs");
  assert.equal(run.outcome_status, "done");
  assert.equal(run.outcome_class, "delivered");
  const atts = db.prepare("SELECT * FROM attempts ORDER BY label").all() as Array<Record<string, unknown>>;
  assert.equal(atts.length, 2);
  assert.equal(atts[0]!.model_key, "composer-2[reasoning_effort=low]");
  assert.equal(atts[0]!.steps, 2);
  assert.equal(atts[0]!.turns, 1);
  assert.equal(atts[0]!.raw_cents, 9);
  assert.equal(atts[0]!.cost_final, 1);
  assert.deepEqual(JSON.parse(String(atts[0]!.tool_calls)), { read: 1 });
  assert.equal(atts[0]!.prompt_text, null, "prompt não é guardado por padrão");
  assert.equal(String(atts[0]!.prompt_hash).length, 16);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM turns").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM usage_runs").get() as { n: number }).n, 2);
  const metrics = db.prepare("SELECT name, value_num, value_text FROM metrics ORDER BY name").all() as Array<Record<string, unknown>>;
  assert.deepEqual(metrics.map((m) => m.name), ["tests_passed", "tier"]);
  db.close();
});

test("label padrão é hash (sem conteúdo do prompt) e banco é 0600", async () => {
  const anon = defineWorkflow({ meta: { name: "anon", description: "x" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("Issue secreta: senha 123") });
  await runWorkflow(anon, {}, { cwd, metricsDb: dbPath });
  const db = await openDb(dbPath);
  const label = (db.prepare("SELECT label FROM attempts").get() as { label: string }).label;
  assert.match(label, /^etapa-[0-9a-f]{8}$/);
  if (process.platform !== "win32") assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  db.close();
});

test("resume: nova execução do mesmo run_id, hits de journal com custo zero e soma sem duplicar", async () => {
  const r1 = await runWorkflow(wf, { n: 1 }, { cwd, metricsDb: dbPath });
  await runWorkflow(wf, { n: 1 }, { cwd, metricsDb: dbPath, runId: r1.runId });
  const db = await openDb(dbPath);
  const execs = (db.prepare("SELECT COUNT(*) n FROM runs WHERE run_id = ?").get(r1.runId) as { n: number }).n;
  assert.equal(execs, 2);
  const cachedRows = (db.prepare("SELECT COUNT(*) n FROM attempts WHERE cached = 'journal'").get() as { n: number }).n;
  assert.equal(cachedRows, 2);
  const s = summary(db, 30);
  assert.equal(s.workflows[0]!.cost_cents, 18, "2 etapas × 9¢ raw, os hits do journal não somam");
  assert.equal(s.savings[0]!.hits, 2);
  assert.equal(s.savings[0]!.est_saved_cents, 18);
  db.close();
});

test("custo por entrega conta o gasto dos runs que falharam", async () => {
  const flaky = defineWorkflow<{ ok: boolean }>({
    meta: { name: "flaky", description: "x" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      await ctx.agent(`p ${ctx.args.ok}`);
      return { status: ctx.args.ok ? "done" : "tests-failed" };
    },
  });
  await runWorkflow(flaky, { ok: true }, { cwd, metricsDb: dbPath });
  await runWorkflow(flaky, { ok: false }, { cwd, metricsDb: dbPath });
  const db = await openDb(dbPath);
  const w = summary(db, 30).workflows[0]!;
  assert.equal(w.runs, 2);
  assert.equal(w.delivered, 1);
  assert.equal(w.cost_per_delivery_cents, 18); // 9 + 9 / 1 entrega
  db.close();
});

test("sem custo do Cursor: estimativa pela tabela pricing, com faixa de contexto", async () => {
  Object.assign(costConfig, { raw: undefined });
  const haiku = defineWorkflow({ meta: { name: "h", description: "h" }, defaults: { model: { id: "claude-haiku-5-5" }, retries: 0 }, run: (ctx) => ctx.agent("x") });
  await runWorkflow(haiku, {}, { cwd, metricsDb: dbPath });
  const db = await openDb(dbPath);
  const a = db.prepare("SELECT cost_source, cost_cents, avg_prompt_per_step, cost_final FROM v_attempts").get() as Record<string, number | string>;
  assert.equal(a.cost_source, "estimate");
  assert.equal(a.cost_final, 0);
  // input 100 (já inclui cache read 60 e cache write 20) / 2 passos = 50 por passo (< 100k): tarifa baixa.
  // input sem cache 20×0.10 + output 10×0.50 + cache read 60×0.01 + cache write 20×0.125 (preços do Haiku 5.5 no Cursor)
  assert.ok(Math.abs(Number(a.cost_cents) - ((20 * 0.1 + 10 * 0.5 + 60 * 0.01 + 20 * 0.125) / 1e6) * 100) < 1e-9);
  // reconcile completa com Agent.getUsage(agentId)
  const rec = await reconcile(db);
  assert.equal(rec.updated, 1);
  assert.equal((db.prepare("SELECT cost_source FROM v_attempts").get() as { cost_source: string }).cost_source, "cursor");
  db.close();
});

test("faixa de contexto e export anonimizado", async () => {
  await runWorkflow(wf, { n: 1 }, { cwd, metricsDb: dbPath });
  const db = await openDb(dbPath);
  const b = summary(db, 30).contextBuckets;
  assert.equal(b[0]!.ctx_bucket_k, 0);
  assert.equal(b[0]!.attempts, 2);
  const ex = exportRows(db, 30);
  assert.equal(ex.runs[0]!.repo_name, null);
  assert.equal(ex.attempts[0]!.agent_id, null);
  assert.match(toCsv(ex.attempts), /^attempt_id,/);
  assert.equal(markRun(db, String(ex.runs[0]!.run_id), "rejected"), 1);
  assert.equal(summary(db, 30).workflows[0]!.human_rejected, 1);
  db.close();
});

test("falha do banco de métricas não derruba o workflow", async () => {
  const warnings: string[] = [];
  const r = await runWorkflow(wf, { n: 1 }, {
    cwd,
    metricsDb: "/dev/null/impossivel/metrics.db",
    onEvent: (e) => e.type === "warning" && warnings.push(e.message),
  });
  assert.equal(r.status, "finished");
  assert.ok(warnings.some((w) => /métricas desligadas/.test(w)));
});

test("classe do resultado", () => {
  assert.equal(outcomeClass("finished", "done"), "delivered");
  assert.equal(outcomeClass("finished", "tests-failed"), "failed");
  assert.equal(outcomeClass("finished"), "unknown");
  assert.equal(outcomeClass("finished", "seams-proposed"), "pending"); // aguarda aprovação, não é falha
  assert.equal(outcomeClass("failed", "done"), "error");
});

test("estimativa usa a tarifa alta quando o prompt médio por passo passa da faixa (Haiku 5.5: 100k)", async () => {
  const db = await openDb(dbPath);
  db.exec(`INSERT INTO runs (exec_id, run_id, workflow, workflow_hash, started_at) VALUES ('e', 'r', 'w', 'h', '2026-11-10T00:00:00Z')`);
  const ins = db.prepare(`INSERT INTO attempts (attempt_id, exec_id, step_key, attempt, model_id, model_key, ok, steps, input_tokens, output_tokens, started_at)
                          VALUES (?, 'e', 'k', 1, 'claude-haiku-5-5', 'claude-haiku-5-5', 1, ?, ?, 1000, '2026-11-10T00:00:00Z')`);
  ins.run("low", 2, 150_000); //  75k por passo → tarifa baixa
  ins.run("high", 1, 150_000); // 150k por passo → tarifa alta
  const cost = (id: string) => (db.prepare("SELECT cost_cents FROM v_attempts WHERE attempt_id = ?").get(id) as { cost_cents: number }).cost_cents;
  assert.ok(Math.abs(cost("low") - ((150_000 * 0.1 + 1000 * 0.5) / 1e6) * 100) < 1e-9);
  assert.ok(Math.abs(cost("high") - ((150_000 * 0.5 + 1000 * 2.5) / 1e6) * 100) < 1e-9);
  db.close();
});

test("tokens como a API devolve: inputTokens já inclui leitura e escrita de cache (prompt = input)", async () => {
  // Medido no Cursor SDK (composer-2.5): totalTokens 3377 = inputTokens 3345 + outputTokens 32; cacheRead 384 está contido no input.
  const db = await openDb(dbPath);
  db.exec(`INSERT INTO runs (exec_id, run_id, workflow, workflow_hash, started_at) VALUES ('e2', 'r2', 'w', 'h', '2026-11-10T00:00:00Z')`);
  db.prepare(`INSERT INTO attempts (attempt_id, exec_id, step_key, attempt, model_id, model_key, ok, steps, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at)
              VALUES ('real', 'e2', 'k', 1, 'claude-haiku-5-5', 'claude-haiku-5-5', 1, 1, 3345, 32, 384, 0, '2026-11-10T00:00:00Z')`).run();
  const a = db.prepare("SELECT prompt_tokens, avg_prompt_per_step, cost_cents FROM v_attempts WHERE attempt_id = 'real'").get() as Record<string, number>;
  assert.equal(a.prompt_tokens, 3345, "o cache não pode ser somado de novo ao input");
  assert.equal(a.avg_prompt_per_step, 3345);
  // Estimativa: input sem cache pela tarifa de input, cache read pela tarifa de cache read (Haiku 5.5 no Cursor: 0,10 / 0,01 / 0,50 por milhão).
  assert.ok(Math.abs(a.cost_cents - (((3345 - 384) * 0.1 + 384 * 0.01 + 32 * 0.5) / 1e6) * 100) < 1e-9, `cost_cents=${a.cost_cents}`);
  db.close();
});

test("estimativa usa o modelo resolvido: alias sem preço próprio ganha o preço do ID do catálogo", async () => {
  // Medido: pedir { id: "composer" } devolve RunResult.model = { id: "composer-2.5" }; getUsage() indisponível.
  Object.assign(costConfig, { raw: undefined });
  script.push(() => ({ status: "finished", result: "ok", model: { id: "composer-2.5" } }));
  const wf = defineWorkflow({ meta: { name: "al", description: "al" }, defaults: { model: { id: "composer" }, retries: 0 }, run: (ctx) => ctx.agent("x") });
  await runWorkflow(wf, {}, { cwd, metricsDb: dbPath });
  const db = await openDb(dbPath);
  const a = db.prepare("SELECT model_id, resolved_model_id, cost_source, cost_cents FROM v_attempts").get() as Record<string, string | number>;
  assert.equal(a.model_id, "composer");
  assert.equal(a.resolved_model_id, "composer-2.5");
  assert.equal(a.cost_source, "estimate");
  assert.ok(Number(a.cost_cents) > 0);
  db.close();
});

test("banco na versão 1 migra para a 2 sem perder linhas", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS } = await import("../src/observability/schema.js");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(dbPath), { recursive: true });
  const old = new DatabaseSync(dbPath);
  old.exec(MIGRATIONS[1]!);
  old.exec("PRAGMA user_version = 1");
  old.exec(`INSERT INTO runs (exec_id, run_id, workflow, workflow_hash, started_at) VALUES ('e', 'r', 'w', 'h', '2026-11-10T00:00:00Z')`);
  old.exec(`INSERT INTO attempts (attempt_id, exec_id, step_key, attempt, model_id, model_key, ok, steps, input_tokens, output_tokens, started_at)
            VALUES ('v1', 'e', 'k', 1, 'composer-2.5', 'composer-2.5', 1, 1, 1000, 10, '2026-11-10T00:00:00Z')`);
  old.close();
  const db = await openDb(dbPath);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  const a = db.prepare("SELECT resolved_model_id, cost_source FROM v_attempts WHERE attempt_id = 'v1'").get() as Record<string, string | null>;
  assert.equal(a.resolved_model_id, null);
  assert.equal(a.cost_source, "estimate");
  db.close();
});
