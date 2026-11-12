// Testes offline do engine (sem rede): `npm test`.
process.env.WF_METRICS = "off"; // estes testes não gravam no banco do usuário
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const cwd = join(import.meta.dirname, ".tmp", String(process.pid)); // one directory per test process: concurrent runs must not share it
const SCHEMA = { type: "object", required: ["tier"], properties: { tier: { enum: ["LOW", "MED", "HIGH"] } } };
const submit = (v: unknown) => (o: any) => {
  o.local.customTools.submit_result.execute(v, {});
  return {};
};
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

test("schema: re-prompt até submit_result válido; 'mcp' entra na allowlist; contexto mdm carregado", async () => {
  script.push(() => ({}), submit({ tier: "BAD" }), submit({ tier: "MED" }));
  const wf = defineWorkflow({
    meta: { name: "s", description: "s" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.agent("classify", { schema: SCHEMA, tools: ["read"] }),
  });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished");
  assert.deepEqual(r.result, { tier: "MED" });
  assert.deepEqual(calls[0].tools, ["read", "mcp"]);
  assert.deepEqual(calls[0].local.settingSources, ["project", "team", "mdm"]);
  assert.equal(stats.disposed, 1);
});

test("schema sem type object na raiz é rejeitado antes de criar agente", async () => {
  const wf = defineWorkflow({ meta: { name: "x", description: "x" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("p", { schema: { type: "array" } }) });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.equal(calls.length, 0);
});

test("argsSchema é validado antes de rodar", async () => {
  const wf = defineWorkflow({
    meta: { name: "a", description: "a", argsSchema: { type: "object", required: ["issue"], properties: { issue: { type: "number" } } } },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.agent("p"),
  });
  const r = await runWorkflow(wf, { issue: "abc" }, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /args inválidos/);
  assert.equal(calls.length, 0);
});

test("etapa que falha em todas as tentativas derruba o workflow (não é pulada)", async () => {
  script.push(() => ({ status: "error", error: { message: "a" } }), () => ({ status: "error", error: { message: "b" } }));
  const wf = defineWorkflow({ meta: { name: "e", description: "e" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("x") });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /falhou após 2 tentativa/);
  assert.equal(stats.disposed, 2);
});

test("timeout: etapa falha, custo é contabilizado e o agente é descartado", async () => {
  script.push(() => ({ hang: true }));
  const wf = defineWorkflow({ meta: { name: "t", description: "t" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("x", { timeoutMs: 50, retries: 0 }) });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /timeout/);
  assert.equal(r.spentCents, 9); // max(bruto 9, cobrado 7)
  assert.equal(r.chargedCents, 7);
  assert.equal(stats.disposed, 1);
});

test("resume: mesmo runId não cria agentes de novo", async () => {
  const wf = defineWorkflow({
    meta: { name: "r", description: "r" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      const p = await ctx.parallel([() => ctx.agent("a"), () => ctx.agent("b")]);
      const q = await ctx.pipeline([1, 2], (x: number) => ctx.agent(`s-${x}`), (prev: string, x: number) => `${prev}:${x}`);
      return { p, q };
    },
  });
  const r1 = await runWorkflow(wf, {}, { cwd });
  const created = calls.length;
  const r2 = await runWorkflow(wf, {}, { cwd, runId: r1.runId });
  assert.equal(calls.length, created);
  assert.deepEqual(r2.result, r1.result);
});

test("concorrência respeita o limite", async () => {
  const wf = defineWorkflow({
    meta: { name: "c", description: "c" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.parallel(Array.from({ length: 8 }, (_, i) => () => ctx.agent(`p${i}`))),
  });
  const r = await runWorkflow(wf, {}, { cwd, concurrency: 2 });
  assert.equal(r.status, "finished");
  assert.ok(stats.maxActive <= 2, `maxActive=${stats.maxActive}`);
});

test("teto de custo aborta, inclusive dentro de parallel", async () => {
  const wf = defineWorkflow({
    meta: { name: "b", description: "b" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      await ctx.agent("1");
      await ctx.agent("2");
      return ctx.parallel([() => ctx.agent("3"), () => ctx.agent("4")]);
    },
  });
  const r = await runWorkflow(wf, {}, { cwd, maxCents: 10 }); // o fake cobra 7¢ por etapa
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de custo/);
});

test("uso por tipo de token é somado e a taxa de cache calculada", async () => {
  const wf = defineWorkflow({ meta: { name: "u", description: "u" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.parallel([() => ctx.agent("a"), () => ctx.agent("b")]) });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.usage.cacheReadTokens, 120);
  assert.equal(r.usage.totalTokens, 220);
  assert.equal(r.usage.cacheHitRatio, 0.6); // 60 / (20 + 60 + 20) por etapa
});

test("settingSources por etapa sobrescreve o default do run", async () => {
  const wf = defineWorkflow({ meta: { name: "ss", description: "ss" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("x", { settingSources: ["team", "mdm"] }) });
  await runWorkflow(wf, {}, { cwd });
  assert.deepEqual(calls[0].local.settingSources, ["team", "mdm"]);
});

test("memo: reaproveita entre runs no mesmo estado do repo e invalida quando o repo muda", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(cwd, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "1");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const wf = defineWorkflow({ meta: { name: "m", description: "m" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("plan", { tools: ["read", "grep"], memo: true }) });

  await runWorkflow(wf, {}, { cwd }); // runId novo a cada chamada
  await runWorkflow(wf, {}, { cwd });
  assert.equal(calls.length, 1, "segundo run deveria vir do memo");

  writeFileSync(join(cwd, "a.txt"), "2"); // mudança local muda a chave
  await runWorkflow(wf, {}, { cwd });
  assert.equal(calls.length, 2);

  writeFileSync(join(cwd, "novo.txt"), "x"); // arquivo novo não rastreado também
  await runWorkflow(wf, {}, { cwd });
  assert.equal(calls.length, 3);
});

test("memo é recusado em etapa que pode escrever", async () => {
  const wf = defineWorkflow({ meta: { name: "mw", description: "mw" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("x", { tools: ["read", "edit"], memo: true }) });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /memo exige/);
  assert.equal(calls.length, 0);
});

const threeSteps = defineWorkflow({
  meta: { name: "cap", description: "cap" },
  defaults: { model: { id: "m" } },
  async run(ctx) {
    await ctx.agent("1");
    await ctx.agent("2");
    return ctx.agent("3");
  },
});

test("teto em centavos conta o custo bruto quando o cobrado é 0 (uso incluído no plano)", async () => {
  Object.assign(costConfig, { raw: 9, charged: 0 });
  const r = await runWorkflow(threeSteps, {}, { cwd, maxCents: 10 });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de custo/);
  assert.equal(calls.length, 2, "a terceira etapa não pode começar: 18¢ brutos já passaram do teto");
  assert.equal(r.spentCents, 18);
  assert.equal(r.chargedCents, 0);
});

test("teto usa o maior entre bruto e cobrado (taxa do Cursor pode deixar o cobrado acima do bruto)", async () => {
  Object.assign(costConfig, { raw: 5, charged: 7 });
  const r = await runWorkflow(threeSteps, {}, { cwd, maxCents: 100 });
  assert.equal(r.status, "finished");
  assert.equal(r.spentCents, 21);
  assert.equal(r.chargedCents, 21);
});

test("custo não reportado gera aviso, e o teto de tokens continua protegendo", async () => {
  Object.assign(costConfig, { raw: undefined });
  const events: any[] = [];
  const r = await runWorkflow(threeSteps, {}, { cwd, maxCents: 1, maxTokens: 150, onEvent: (e) => events.push(e) });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens/);
  assert.equal(r.spentCents, 0);
  assert.ok(events.some((e) => e.type === "warning" && /custo .*não reportado/.test(e.message)), "deveria avisar que o teto em centavos não contou a etapa");
});

test("getUsage() indisponível (403 feature_unavailable): tokens vêm dos eventos turn-ended e o teto de tokens dispara", async () => {
  Object.assign(costConfig, { getUsageError: "feature_unavailable: usage for local agents is not enabled" });
  const events: any[] = [];
  const r = await runWorkflow(threeSteps, {}, { cwd, maxTokens: 150, onEvent: (e) => events.push(e) });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens/);
  assert.equal(calls.length, 2, "a terceira etapa não pode começar: 220 tokens dos turnos já passaram do teto");
  assert.equal(r.spentTokens, 220); // 20 + 10 + 60 + 20 por etapa, somados dos turn-ended
  assert.equal(r.spentCents, 0);
  assert.ok(events.some((e) => e.type === "warning" && /getUsage\(\) falhou/.test(e.message)), "deveria avisar que o custo é desconhecido");
  assert.ok(!events.some((e) => e.type === "warning" && /o de tokens, sim/.test(e.message)), "não pode dizer que o teto de tokens contou pelo getUsage");
});

test("plano sem acesso ao SDK (plan_required) encerra o run na primeira tentativa, inclusive dentro de parallel", async () => {
  Object.assign(costConfig, { createErrorCode: "plan_required" });
  const wf = defineWorkflow({
    meta: { name: "pr", description: "pr" },
    defaults: { model: { id: "m" } },
    run: (ctx) => ctx.parallel([() => ctx.agent("a"), () => ctx.agent("b")]),
  });
  const r = await runWorkflow(wf, {}, { cwd, concurrency: 1 });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /plan_required/);
  assert.match(r.error!, /plano/);
  assert.equal(calls.length, 1, "sem nova tentativa nem a segunda etapa do parallel");
});

test("tokens como a API devolve: total = input + output e taxa de cache = cacheRead / input", async () => {
  Object.assign(costConfig, { getUsageError: "feature_unavailable" });
  const usage = { inputTokens: 3345, outputTokens: 32, cacheReadTokens: 384, cacheWriteTokens: 0 };
  script.push(() => ({ status: "finished", result: "OK", deltas: [{ type: "step-completed", stepId: 1 }, { type: "turn-ended", usage }] }));
  const wf = defineWorkflow({ meta: { name: "rt", description: "rt" }, defaults: { model: { id: "m" } }, run: (ctx) => ctx.agent("x") });
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "finished");
  assert.equal(r.spentTokens, 3377);
  assert.equal(r.usage.totalTokens, 3377);
  assert.equal(r.usage.cacheHitRatio, 0.115); // 384 / 3345
});

test("step-end traz o modelo resolvido pelo Cursor (alias → ID do catálogo)", async () => {
  // Medido: pedir { id: "composer" } devolve RunResult.model = { id: "composer-2.5" }.
  script.push(() => ({ status: "finished", result: "OK", model: { id: "composer-2.5" } }));
  const events: any[] = [];
  const wf = defineWorkflow({ meta: { name: "rm", description: "rm" }, defaults: { model: { id: "composer" } }, run: (ctx) => ctx.agent("x") });
  await runWorkflow(wf, {}, { cwd, onEvent: (e) => events.push(e) });
  const end = events.find((e) => e.type === "step-end");
  assert.equal(end.model, "composer");
  assert.equal(end.resolvedModel, "composer-2.5");
});

test("guarda contra recursão: com settingSources de arquivo, um MCP inline 'workflows' sem tools substitui o do projeto", async () => {
  // Medido: o SDK sobe os servidores do .cursor/mcp.json sem repassar WF_INSIDE_WORKFLOW, e a etapa via start_workflow.
  const wf = defineWorkflow({
    meta: { name: "g", description: "g" },
    defaults: { model: { id: "m" } },
    async run(ctx) {
      await ctx.agent("com projeto");
      await ctx.agent("sem arquivos", { settingSources: ["team", "mdm"] });
    },
  });
  await runWorkflow(wf, {}, { cwd });
  const guard = calls[0].mcpServers?.workflows;
  assert.ok(guard, "a etapa com 'project' precisa do servidor inline que substitui o do projeto");
  assert.equal(guard.env?.WF_INSIDE_WORKFLOW, "1");
  assert.match(guard.args?.join(" ") ?? "", /nested-mcp-guard\.mjs$/);
  assert.equal(calls[1].mcpServers?.workflows, undefined, "sem camadas de arquivo não há o que substituir");
});

test("teto padrão declarado pelo workflow vale sem --max-tokens; null explícito desliga", async () => {
  const capped = { ...threeSteps, budget: { maxTokens: 150 } };
  const r = await runWorkflow(capped, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /Teto de tokens/);
  calls.length = 0;
  const free = await runWorkflow(capped, {}, { cwd, maxTokens: null });
  assert.equal(free.status, "finished", free.error);
});
