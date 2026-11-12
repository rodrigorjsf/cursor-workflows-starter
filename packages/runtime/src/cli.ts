#!/usr/bin/env node
// CLI `wf`: roda workflows no terminal, em CI, ou a partir do shell do agente do Cursor.
//
//   wf login                          # login do SDK no navegador (conta do próprio usuário)
//   wf whoami                         # mostra a conta em uso
//   wf models                         # IDs de modelo liberados para a chave em uso
//   wf list
//   wf init [--no-agents-md | --remove]   # writes the kit's files into the repo (MCP configs, repo config, .gitignore, AGENTS.md block); prints the diff, never commits
//   wf config show [workflow]         # effective config of the current repo and where each value came from
//   wf upgrade                        # moves the installed kit (~/.cursor-workflows/kit) to the newest release tag and redoes its dependencies, shim and skill links
//   wf doctor [--json]                # checks the environment the IDE uses (Node, dependencies, login, models, gh, MCP server, config, kit version); exits 1 when a check fails
//   wf run <workflow> --args '<json>' [--max-cents N] [--resume <runId>]   # primeiro plano; imprime JSON no fim
//   wf start <workflow> --args '<json>' [--resume <runId>]                 # segundo plano; imprime {jobId}
//   wf status <jobId>
//   wf wait <jobId> [--timeout 240]       # espera até o timeout e imprime o estado
//   wf cancel <jobId> [--timeout 30]      # cancel the job (SIGTERM to its process) and wait for it to stop; the run stays resumable
//   wf jobs
//   wf gc [--dry-run]                     # removes the worktrees, local branches and origin branches of implement-issue runs whose PR was merged or closed, or that failed long ago, and the cloud snapshot branches their steps left on the cloud.remote remote; --dry-run only prints the plan
//   wf stats [--days 30]                  # resumo de custo/eficiência (banco ~/.cursor-workflows/metrics.db)
//   wf metrics export [--days 30] [--format csv|json] [--out dir] [--no-anonymize]
//   wf metrics reconcile                  # completa custos que o Cursor ainda não tinha reportado
//   wf metrics mark <runId> accepted|rejected
//
// `start` runs the job in a detached process. SIGINT (Ctrl-C) or SIGTERM on a running `run` cancels it, like `wf cancel`.
// `run` and `start` also take --overrides '<json>': limits tighter than the config's, for this run only (the chat's layer).
//
// STATUS: verificado contra a API real num plano Premium em 2026-11-11 (docs/research/verificacoes-locais.md).

import "./console-to-stderr.js"; // o stdout leva o JSON do resultado: o console do SDK vai para o stderr
import "./node-check.js"; // antes de tudo: o @cursor/sdk exige Node 22.13+
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Cursor } from "@cursor/sdk";
import { globalConfigPath, loadEffectiveConfig, parseLimitOverrides, repoConfigPath } from "./config/index.js";
import { formatReport, runDoctor } from "./doctor.js";
import { initRepo } from "./init.js";
import { assertKitCompatible } from "./kit-version.js";
import { unifiedDiff } from "./unified-diff.js";
import { upgradeKit } from "./upgrade.js";
import { INSIDE_WORKFLOW_ENV, type RunStatus, runWorkflow } from "./runtime/engine.js";
import { cancelOnSignals, installCrashHandlers, spawnJob, startJob } from "./runtime/jobs.js";
import { cancelJob, listJobs, readJob, readJobRecord, waitJob } from "./runtime/job-state.js";
import { loadWorkflows } from "./runtime/registry.js";
import { applyGc, directCommands, formatPlan, planGc } from "../workflows/implement-issue/gc.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    args: { type: "string", default: "{}" },
    cwd: { type: "string", default: process.cwd() },
    "max-cents": { type: "string" },
    "max-tokens": { type: "string" },
    overrides: { type: "string" },
    resume: { type: "string" },
    job: { type: "string" },
    timeout: { type: "string", default: "240" },
    days: { type: "string", default: "30" },
    format: { type: "string", default: "csv" },
    out: { type: "string" },
    "no-anonymize": { type: "boolean", default: false },
    "no-agents-md": { type: "boolean", default: false },
    remove: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const [command, name] = positionals;
const cwd = resolve(values.cwd!);
const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
/** `--timeout`, in milliseconds. A value that is not a number of seconds is an error: it would make the wait return at once. */
const timeoutMs = (): number => {
  const seconds = Number(values.timeout);
  if (values.timeout!.trim() === "" || !Number.isFinite(seconds) || seconds < 0) throw new Error(`--timeout must be a number of seconds, 0 or more; got "${values.timeout}"`);
  return seconds * 1000;
};
/** The flag layer of the config: only what the command line says. WF_MAX_* are the env layer, read by the config. */
const flagLimits = () => {
  const number = (flag: "max-cents" | "max-tokens") => {
    const raw = values[flag];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0) throw new Error(`--${flag} must be a number, 0 or more; got "${raw}"`);
    return n;
  };
  return { maxCents: number("max-cents"), maxTokens: number("max-tokens") };
};
/** The chat's layer of the config (`--overrides`): only what the MCP server forwards to the process it spawns. */
const overridesFlag = () => (values.overrides === undefined ? undefined : parseLimitOverrides(JSON.parse(values.overrides)));
const runOpts = () => ({
  cwd,
  runId: values.resume,
  ...flagLimits(),
  mcpOverrides: overridesFlag(),
  onEvent: (e: unknown) => process.stderr.write(JSON.stringify(e) + "\n"),
});
/** 0 finished; 130 cancelled (the shell's code for a run stopped by SIGINT); 1 failed. */
const exitCodeOf = (status: RunStatus) => (status === "finished" ? 0 : status === "cancelled" ? 130 : 1);

async function resolveWorkflow() {
  const def = (await loadWorkflows(cwd)).get(name ?? "");
  if (!def) throw new Error(`unknown workflow: ${name}. Use \`wf list\`.`);
  return def;
}

async function main(): Promise<number> {
  installCrashHandlers();
  if ((command === "run" || command === "start") && process.env[INSIDE_WORKFLOW_ENV] === "1" && !values.job) {
    throw new Error("workflows cannot be started from inside a workflow step");
  }
  if (command === "run" || command === "start") assertKitCompatible(cwd); // before anything starts: a kit outside the repo's declared range is refused
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
    case "init": {
      const { changes, notes } = initRepo({ cwd, skipAgentsMd: values["no-agents-md"], remove: values.remove });
      // stdout is the diff alone (empty when there is nothing to change); the summary goes to stderr.
      for (const { path, before, after } of changes) process.stdout.write(unifiedDiff(path, before, after));
      process.stderr.write(changes.length ? `wf init: ${changes.length} file(s) changed in ${cwd}. Nothing was committed: review the diff and commit it yourself.\n` : "wf init: nothing to change, the repository is already set up.\n");
      for (const note of notes) process.stderr.write(`wf init: ${note}\n`);
      return 0;
    }
    case "doctor": {
      const report = await runDoctor({ cwd });
      if (values.json) out(report);
      else process.stdout.write(formatReport(report));
      return report.ok ? 0 : 1;
    }
    case "upgrade": {
      const result = upgradeKit();
      out(result);
      process.stderr.write(
        result.upgraded
          ? `wf upgrade: kit ${result.from} -> ${result.to} (${result.tag}). Run \`wf doctor\` in each repository that uses the kit.\n`
          : `wf upgrade: kit ${result.from} is already the newest version (${result.tag}).\n`,
      );
      return 0;
    }
    case "config": {
      if (name !== "show") throw new Error("usage: wf config show [workflow] [--max-tokens N] [--max-cents N]");
      const known = await loadWorkflows(cwd);
      const wanted = positionals[2];
      if (wanted !== undefined && !known.has(wanted)) throw new Error(`unknown workflow: ${wanted}. Use \`wf list\`.`);
      const shown = (wanted === undefined ? [...known.values()] : [known.get(wanted)!]).map((def) => {
        const { config, provenance, violations } = loadEffectiveConfig(def, { cwd, flags: flagLimits() });
        return [def.meta.name, { config, provenance, violations }] as const;
      });
      const file = (path: string) => ({ path, found: existsSync(path) });
      out({ files: { global: file(globalConfigPath()), repo: file(repoConfigPath(cwd)) }, workflows: Object.fromEntries(shown) });
      return 0;
    }
    case "run": {
      const def = await resolveWorkflow();
      const args = JSON.parse(values.args!);
      const opts = { ...runOpts(), signal: cancelOnSignals() }; // SIGINT and SIGTERM cancel the run, the same as `wf cancel`
      if (values.job) {
        // Child mode of `wf start` and `start_workflow`: the parent already created the job.
        const existing = readJobRecord(cwd, values.job);
        if (!existing) throw new Error(`job not found: ${values.job}`);
        const { done } = startJob(def, args, opts, existing);
        const state = await done;
        if (state.status !== "finished" && state.error) process.stderr.write(`${state.error}\n`); // goes to the job's log (.workflows/jobs/<jobId>.log)
        return exitCodeOf(state.status === "running" ? "failed" : state.status);
      }
      const outcome = await runWorkflow(def, args, opts);
      out(outcome);
      return exitCodeOf(outcome.status);
    }
    case "start": {
      // Valida no pai, antes do spawn, para o erro aparecer aqui e não sumir num processo destacado.
      const def = await resolveWorkflow();
      const args = JSON.parse(values.args!);
      const overrides = overridesFlag();
      const { violations } = loadEffectiveConfig(def, { cwd, flags: flagLimits(), mcpOverrides: overrides }); // an unusable config fails here, with its field path
      const { job, log } = spawnJob({ cwd, workflow: def.meta.name, args, resumeRunId: values.resume, ...flagLimits(), overrides });
      out({ jobId: job.jobId, runId: job.runId, log, next: `wf wait ${job.jobId}`, ...(violations.length ? { violations } : {}) });
      return 0;
    }
    case "status": {
      out(readJob(cwd, name ?? "") ?? { error: "job not found" });
      return 0;
    }
    case "wait": {
      out((await waitJob(cwd, name ?? "", timeoutMs())) ?? { error: "job not found" });
      return 0;
    }
    case "cancel": {
      // Waits for the process to stop (it cancels the agents, reverts the in-flight step and writes the run's end), 30 s at most.
      out((await cancelJob(cwd, name ?? "", Math.min(timeoutMs(), 30_000))) ?? { error: "job not found" });
      return 0;
    }
    case "jobs": {
      out(listJobs(cwd).map(({ jobId, workflow, status, phase, runId }) => ({ jobId, workflow, status, phase, runId })));
      return 0;
    }
    case "gc": {
      const def = (await loadWorkflows(cwd)).get("implement-issue");
      if (!def) throw new Error("unknown workflow: implement-issue. Use `wf list`.");
      const { config } = loadEffectiveConfig(def, { cwd });
      const { gcFailedAfterDays: failedAfterDays, gcSnapshotGraceHours: graceHours, networkTimeoutSec } = config.settings;
      if (typeof failedAfterDays !== "number") throw new Error("workflows.implement-issue.settings.gcFailedAfterDays must be a number of days");
      if (typeof graceHours !== "number") throw new Error("workflows.implement-issue.settings.gcSnapshotGraceHours must be a number of hours");
      if (typeof networkTimeoutSec !== "number") throw new Error("workflows.implement-issue.settings.networkTimeoutSec must be a number of seconds");
      const commands = directCommands(networkTimeoutSec);
      const plan = await planGc({ cwd, commands, failedAfterDays, snapshots: { remote: config.cloud.remote, graceHours } });
      process.stderr.write(formatPlan(plan)); // the plan first, then the removal
      if (values["dry-run"]) process.stderr.write("wf gc: dry run, nothing was changed.\n");
      else await applyGc(plan, commands);
      out({ dryRun: values["dry-run"], ...plan });
      return plan.errors.length ? 1 : 0;
    }
    case "stats": {
      const { openDb } = await import("./observability/db.js");
      const { summary } = await import("./observability/queries.js");
      const db = await openDb();
      const s = summary(db, Number(values.days));
      for (const [section, rows] of Object.entries(s)) {
        process.stdout.write(`\n== ${section}\n`);
        if (rows.length) console.table(rows);
        else process.stdout.write("(no data)\n");
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
          if (!runId || (verdict !== "accepted" && verdict !== "rejected")) throw new Error("usage: wf metrics mark <runId> accepted|rejected");
          out({ runId, verdict, updated: q.markRun(db, runId, verdict) });
          return 0;
        }
        throw new Error("usage: wf metrics <export|reconcile|mark> ...");
      } finally {
        db.close();
      }
    }
    default:
      process.stderr.write("usage: wf <login|whoami|models|list|init|doctor|upgrade|config|run|start|status|wait|cancel|jobs|gc|stats|metrics> ...\n");
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
