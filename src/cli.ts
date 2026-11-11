#!/usr/bin/env node
// CLI `wf`: roda workflows no terminal, em CI, ou a partir do shell do agente do Cursor.
//
//   wf login                          # login do SDK no navegador (conta do próprio usuário)
//   wf whoami                         # mostra a conta em uso
//   wf models                         # IDs de modelo liberados para a chave em uso
//   wf list
//   wf run <workflow> --args '<json>' [--max-cents N] [--resume <runId>]   # primeiro plano; imprime JSON no fim
//   wf start <workflow> --args '<json>' [--resume <runId>]                 # segundo plano; imprime {jobId}
//   wf status <jobId>
//   wf wait <jobId> [--timeout 240]       # espera até o timeout e imprime o estado
//   wf jobs
//   wf stats [--days 30]                  # resumo de custo/eficiência (banco ~/.cursor-workflows/metrics.db)
//   wf metrics export [--days 30] [--format csv|json] [--out dir] [--no-anonymize]
//   wf metrics reconcile                  # completa custos que o Cursor ainda não tinha reportado
//   wf metrics mark <runId> accepted|rejected
//
// STATUS: verificado contra a API real num plano Premium em 2026-11-11 (docs/research/verificacoes-locais.md).

import "./node-check.js"; // antes de tudo: o @cursor/sdk exige Node 22.13+
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Cursor } from "@cursor/sdk";
import { INSIDE_WORKFLOW_ENV, runWorkflow } from "./runtime/engine.js";
import { createJob, installCrashHandlers, jobLogPath, listJobs, readJob, startJob, waitJob, writeJob } from "./runtime/jobs.js";
import { loadWorkflows } from "./runtime/registry.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    args: { type: "string", default: "{}" },
    cwd: { type: "string", default: process.cwd() },
    "max-cents": { type: "string" },
    "max-tokens": { type: "string" },
    resume: { type: "string" },
    job: { type: "string" },
    timeout: { type: "string", default: "240" },
    days: { type: "string", default: "30" },
    format: { type: "string", default: "csv" },
    out: { type: "string" },
    "no-anonymize": { type: "boolean", default: false },
  },
});

const [command, name] = positionals;
const cwd = resolve(values.cwd!);
const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
const runOpts = () => ({
  cwd,
  runId: values.resume,
  maxCents: values["max-cents"] ? Number(values["max-cents"]) : Number(process.env.WF_MAX_CENTS) || undefined, // sem valor: teto padrão do workflow
  maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : Number(process.env.WF_MAX_TOKENS) || undefined,
  onEvent: (e: unknown) => process.stderr.write(JSON.stringify(e) + "\n"),
});

async function resolveWorkflow() {
  const def = (await loadWorkflows(cwd)).get(name ?? "");
  if (!def) throw new Error(`workflow desconhecido: ${name}. Use \`wf list\`.`);
  return def;
}

async function main(): Promise<number> {
  installCrashHandlers();
  if ((command === "run" || command === "start") && process.env[INSIDE_WORKFLOW_ENV] === "1" && !values.job) {
    throw new Error("workflows não podem ser iniciados de dentro de uma etapa de workflow");
  }
  switch (command) {
    case "login": {
      const r = await Cursor.auth.login();
      // Nunca imprimir r.apiKey: a saída pode acabar no transcript do chat.
      out({ loggedIn: true, email: r.email, expiresAt: new Date(r.apiKeyExpiresAtMs).toISOString() });
      return 0;
    }
    case "models": {
      // IDs liberados para a chave em uso (plano + restrições do admin), com aliases e parâmetros.
      const models = await Cursor.models.list();
      out(models.map((m) => ({ id: m.id, displayName: m.displayName, aliases: m.aliases, params: m.parameters?.map((p) => `${p.id}=${p.values.map((v) => v.value).join("|")}`) })));
      return 0;
    }
    case "whoami": {
      const me = await Cursor.me();
      out({ apiKeyName: me.apiKeyName, userEmail: me.userEmail });
      return 0;
    }
    case "list": {
      out([...(await loadWorkflows(cwd)).values()].map((w) => ({ name: w.meta.name, description: w.meta.description })));
      return 0;
    }
    case "run": {
      const def = await resolveWorkflow();
      const args = JSON.parse(values.args!);
      if (values.job) {
        // Modo filho de `wf start`: o pai já criou o job.
        const existing = readJob(cwd, values.job);
        if (!existing) throw new Error(`job ${values.job} não encontrado`);
        const { done } = startJob(def, args, runOpts(), existing);
        return (await done).status === "finished" ? 0 : 1;
      }
      const outcome = await runWorkflow(def, args, runOpts());
      out(outcome);
      return outcome.status === "finished" ? 0 : 1;
    }
    case "start": {
      // Valida no pai, antes do spawn, para o erro aparecer aqui e não sumir num processo destacado.
      const def = await resolveWorkflow();
      JSON.parse(values.args!);
      const job = createJob(cwd, def.meta.name, values.resume);
      const log = openSync(jobLogPath(cwd, job.jobId), "a");
      const child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1]!, "run", def.meta.name, "--args", values.args!, "--cwd", cwd, "--job", job.jobId,
          ...(values["max-cents"] ? ["--max-cents", values["max-cents"]] : []),
          ...(values["max-tokens"] ? ["--max-tokens", values["max-tokens"]] : [])],
        { detached: true, stdio: ["ignore", log, log], env: process.env },
      );
      // O job nasceu com o pid do pai (que sai já); aponta para o filho, que também grava o próprio pid ao iniciar.
      const current = readJob(cwd, job.jobId);
      if (current && child.pid) writeJob(cwd, { ...current, pid: child.pid });
      child.unref();
      out({ jobId: job.jobId, runId: job.runId, log: jobLogPath(cwd, job.jobId), next: `wf wait ${job.jobId}` });
      return 0;
    }
    case "status": {
      out(readJob(cwd, name ?? "") ?? { error: "job não encontrado" });
      return 0;
    }
    case "wait": {
      out((await waitJob(cwd, name ?? "", Number(values.timeout) * 1000)) ?? { error: "job não encontrado" });
      return 0;
    }
    case "jobs": {
      out(listJobs(cwd).map(({ jobId, workflow, status, phase, runId }) => ({ jobId, workflow, status, phase, runId })));
      return 0;
    }
    case "stats": {
      const { openDb } = await import("./observability/db.js");
      const { summary } = await import("./observability/queries.js");
      const db = await openDb();
      const s = summary(db, Number(values.days));
      for (const [section, rows] of Object.entries(s)) {
        process.stdout.write(`\n== ${section}\n`);
        if (rows.length) console.table(rows);
        else process.stdout.write("(sem dados)\n");
      }
      db.close();
      return 0;
    }
    case "metrics": {
      const { openDb } = await import("./observability/db.js");
      const q = await import("./observability/queries.js");
      const db = await openDb();
      try {
        const sub = name;
        if (sub === "export") {
          const rows = q.exportRows(db, Number(values.days), !values["no-anonymize"]);
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const dir = resolve(values.out ?? "metrics-export");
          mkdirSync(dir, { recursive: true });
          for (const [table, data] of Object.entries(rows)) {
            const file = join(dir, `${table}.${values.format === "json" ? "json" : "csv"}`);
            writeFileSync(file, values.format === "json" ? JSON.stringify(data, null, 2) : q.toCsv(data));
          }
          out({ exported: dir, anonymized: !values["no-anonymize"], counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])) });
          return 0;
        }
        if (sub === "reconcile") {
          out(await q.reconcile(db));
          return 0;
        }
        if (sub === "mark") {
          const [, , runId, verdict] = positionals;
          if (!runId || (verdict !== "accepted" && verdict !== "rejected")) throw new Error("uso: wf metrics mark <runId> accepted|rejected");
          out({ runId, verdict, updated: q.markRun(db, runId, verdict) });
          return 0;
        }
        throw new Error("uso: wf metrics <export|reconcile|mark> ...");
      } finally {
        db.close();
      }
    }
    default:
      process.stderr.write("uso: wf <login|whoami|list|run|start|status|wait|jobs|stats|metrics> ...\n");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
