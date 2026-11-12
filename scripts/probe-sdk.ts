// WHAT: Probes @cursor/sdk against the real API with one short send: smoke, invalid model id, or a read-4-files run.
// WHY: The runtime assumes things about events, usage and cost that only the live API can confirm (see
//   docs/research).
// WHEN: After upgrading @cursor/sdk, on a new account or plan, or to re-check whether getUsage() now reports cost
//   for local agents.
// HOW: `npx tsx scripts/probe-sdk.ts --model <id> --mode smoke|invalid-model|read`; options are listed below. Spends
//   tokens, never prints the key.

// Sonda do @cursor/sdk contra a API real: mede o que o kit assume sobre eventos, uso e custo.
// Nunca imprime a API key. Cada modo faz no máximo um send() curto.
//
//   npx tsx scripts/probe-sdk.ts --model <id> --mode smoke          # 1 send sem tools ("responda OK")
//   npx tsx scripts/probe-sdk.ts --model <id> --mode invalid-model  # ID inexistente: classe e mensagem do erro
//   npx tsx scripts/probe-sdk.ts --model <id> --mode read           # 1 send que lê 4 arquivos: granularidade dos eventos
//   opções: --cwd <dir> (default: diretório atual) --setting-sources project,team (default: nenhuma)
//           --cost-waits 0,5,15,30 (segundos após o fim da run para reler getUsage)

import { parseArgs } from "node:util";
import { Agent, type SettingSource } from "@cursor/sdk";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    mode: { type: "string", default: "smoke" },
    cwd: { type: "string", default: process.cwd() },
    "setting-sources": { type: "string", default: "" },
    "cost-waits": { type: "string", default: "0,5,15,30" },
  },
});
if (!values.model) throw new Error("--model é obrigatório (veja `npm run models`)");

const PROMPTS: Record<string, string> = {
  smoke: "Responda apenas com a palavra OK. Não use ferramentas.",
  "invalid-model": "Responda apenas com a palavra OK.",
  read:
    "Leia os arquivos package.json, tsconfig.json, AGENTS.md e README.md deste diretório. " +
    "Responda com uma linha por arquivo: o nome do arquivo e o número de linhas dele. Não edite nada.",
};
const mode = values.mode!;
if (!(mode in PROMPTS)) throw new Error(`--mode inválido: ${mode}`);
const model = { id: mode === "invalid-model" ? "wf-probe-modelo-inexistente" : values.model };
const settingSources = values["setting-sources"]!.split(",").filter(Boolean) as SettingSource[];
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const errInfo = (e: unknown) => ({
  class: e instanceof Error ? e.name : typeof e,
  message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
  code: (e as { code?: unknown })?.code,
  isRetryable: (e as { isRetryable?: unknown })?.isRetryable,
});

const out: Record<string, unknown> = { mode, requestedModel: model, settingSources, startedAt: new Date().toISOString() };
const deltaCounts: Record<string, number> = {};
const turnUsages: unknown[] = [];
const toolCalls: string[] = [];

let agent: Awaited<ReturnType<typeof Agent.create>>;
try {
  agent = await Agent.create({
    model,
    local: { cwd: values.cwd!, settingSources },
    tools: mode === "read" ? ["read", "glob", "ls"] : [],
  });
} catch (e) {
  // Ex.: plano Free: a validação local do modelo chama GET /v1/models e recebe 403 plan_required.
  out.createError = { ...errInfo(e), status: (e as { status?: unknown }).status, endpoint: (e as { endpoint?: unknown }).endpoint, operation: (e as { operation?: unknown }).operation };
  console.log(JSON.stringify(out, null, 2));
  process.exit(2);
}
out.agentId = agent.agentId;
try {
  const t0 = Date.now();
  const run = await agent.send(PROMPTS[mode], {
    onDelta: ({ update }) => {
      const u = update as { type: string; usage?: unknown; toolCall?: { type?: string } };
      deltaCounts[u.type] = (deltaCounts[u.type] ?? 0) + 1;
      if (u.type === "turn-ended") turnUsages.push(u.usage);
      if (u.type === "tool-call-started") toolCalls.push(u.toolCall?.type ?? "?");
    },
  });
  const r = await run.wait();
  out.run = {
    status: r.status,
    resultPreview: r.result?.slice(0, 200),
    error: r.error,
    model: r.model,
    usage: r.usage,
    durationMs: r.durationMs,
    wallMs: Date.now() - t0,
  };
  out.deltas = deltaCounts;
  out.turnEndedUsages = turnUsages;
  out.toolCalls = toolCalls;

  // Custo "eventualmente consistente": relê getUsage() em vários instantes depois do fim da run.
  const reads: unknown[] = [];
  let waited = 0;
  for (const s of values["cost-waits"]!.split(",").map(Number)) {
    await sleep(s - waited);
    waited = s;
    const u = await agent.getUsage().catch((e) => ({ error: errInfo(e) }));
    reads.push({ afterSec: s, usage: (u as { usage?: unknown }).usage, cost: (u as { cost?: unknown }).cost ?? null, runs: (u as { runs?: unknown[] }).runs?.length, error: (u as { error?: unknown }).error });
  }
  out.getUsageReads = reads;
  const last = (await agent.getUsage().catch(() => undefined)) as { runs?: unknown[] } | undefined;
  out.usageRuns = last?.runs;
} catch (e) {
  out.error = errInfo(e);
} finally {
  await agent[Symbol.asyncDispose]();
}

// O `wf metrics reconcile` depende de ler o uso de um agente local já descartado.
try {
  const s = await Agent.getUsage(String(out.agentId));
  out.staticGetUsageAfterDispose = { ok: true, usage: s.usage, cost: s.cost ?? null, runs: s.runs.length };
} catch (e) {
  out.staticGetUsageAfterDispose = { ok: false, error: errInfo(e) };
}

console.log(JSON.stringify(out, null, 2));
