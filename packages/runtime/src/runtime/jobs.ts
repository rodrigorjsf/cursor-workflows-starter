// Jobs: execução assíncrona com estado em disco, para que o chat do Cursor dispare um workflow
// longo e consulte o resultado depois (MCP e shell do agente têm timeouts; um workflow de
// implementação leva minutos). CLI e MCP leem o mesmo diretório, então um job iniciado por um
// pode ser consultado pelo outro.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./state.js";
import { type RunOptions, type RunOutcome, type WorkflowEvent, newRunId, runWorkflow } from "./engine.js";
import type { WorkflowDefinition } from "./workflow.js";

export interface JobState {
  jobId: string;
  workflow: string;
  status: "running" | "finished" | "failed";
  /** Gravado no início: permite retomar com o mesmo journal mesmo se o processo morrer. */
  runId: string;
  /** Processo que executa o job; usado para detectar job órfão. */
  pid: number;
  startedAt: string;
  finishedAt?: string;
  phase?: string;
  /** Últimos eventos, para o agente do chat mostrar progresso. */
  recent: string[];
  result?: unknown;
  error?: string;
  /** Custo que o teto usa: Σ max(bruto, cobrado). */
  spentCents?: number;
  /** Só o cobrado (0 para uso incluído no plano). */
  chargedCents?: number;
  spentTokens?: number;
  usage?: RunOutcome<unknown>["usage"];
}

export function jobsDir(cwd: string): string {
  return stateDir(cwd, "jobs");
}

export function jobLogPath(cwd: string, jobId: string): string {
  return join(jobsDir(cwd), `${jobId}.log`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readJob(cwd: string, jobId: string): JobState | undefined {
  const file = join(jobsDir(cwd), `${jobId}.json`);
  if (!existsSync(file)) return undefined;
  const job = JSON.parse(readFileSync(file, "utf8")) as JobState;
  if (job.status === "running" && !isAlive(job.pid)) {
    // Processo morreu sem fechar o job (crash, reinício do MCP server, máquina desligada).
    job.status = "failed";
    job.error = `processo ${job.pid} terminou sem concluir o job; relance com resumeRunId="${job.runId}"`;
    writeJob(cwd, job);
  }
  return job;
}

export function listJobs(cwd: string): JobState[] {
  return readdirSync(jobsDir(cwd))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJob(cwd, f.slice(0, -5)))
    .filter((j): j is JobState => Boolean(j));
}

export function writeJob(cwd: string, job: JobState): void {
  writeFileSync(join(jobsDir(cwd), `${job.jobId}.json`), JSON.stringify(job, null, 2));
}

/** Cria o registro do job antes de rodar (CLI `start` grava no pai, antes do spawn). */
export function createJob(cwd: string, workflow: string, runId?: string, jobId: string = randomUUID().slice(0, 8), pid = process.pid): JobState {
  // Data/hora ficam no job, não no workflow: o script precisa ser determinístico para o resume.
  const job: JobState = {
    jobId,
    workflow,
    status: "running",
    runId: runId ?? newRunId(workflow),
    pid,
    startedAt: new Date().toISOString(),
    recent: [],
  };
  writeJob(cwd, job);
  return job;
}

function describe(e: WorkflowEvent): string | undefined {
  switch (e.type) {
    case "log":
      return e.message;
    case "phase":
      return `== ${e.title}`;
    case "step-start":
      return `▶ ${e.label} [${e.model ?? "?"}]${e.attempt > 1 ? ` tentativa ${e.attempt}` : ""}`;
    case "step-end": {
      const cache = e.usage && e.usage.cacheReadTokens > 0 ? ` cache-read ${e.usage.cacheReadTokens}` : "";
      // Custo como o teto o conta: max(bruto, cobrado). O cobrado sozinho é 0 para uso incluído no plano.
      const cents = Math.max(e.rawCents ?? 0, e.chargedCents);
      return `${e.ok ? "✓" : "✗"} ${e.label}${e.cached ? ` (${e.cached})` : ""}${cents ? ` ${cents}¢` : ""}${cache}`;
    }
    case "warning":
      return `⚠ ${e.message}`;
    case "metric":
      return `· ${e.name} = ${e.value}`;
    case "run-start":
    case "run-end":
    case "turn":
      return undefined;
  }
}

const activeJobs = new Map<string, { cwd: string; job: JobState }>();

/**
 * Handlers de processo para MCP server e CLI. O cookbook oficial (dag-task-runner) avisa que o SDK
 * dispara promises não aguardadas durante a inicialização do agente; sem handler, uma rejeição
 * derruba o processo e os jobs ficam "running" para sempre.
 */
export function installCrashHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[wf] unhandledRejection ignorada: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  });
  process.on("uncaughtException", (err) => {
    for (const { cwd, job } of activeJobs.values()) {
      Object.assign(job, { status: "failed", error: `crash: ${err.message}; relance com resumeRunId="${job.runId}"`, finishedAt: new Date().toISOString() });
      writeJob(cwd, job);
    }
    process.stderr.write(`[wf] uncaughtException: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}

/** Roda o workflow no processo atual para um job já criado (ou cria um). */
export function startJob<A>(
  def: WorkflowDefinition<A, unknown>,
  args: A,
  opts: RunOptions,
  existing?: JobState,
): { job: JobState; done: Promise<JobState> } {
  const job = existing ?? createJob(opts.cwd, def.meta.name, opts.runId);
  job.pid = process.pid;
  writeJob(opts.cwd, job);
  activeJobs.set(job.jobId, { cwd: opts.cwd, job });
  const done = runWorkflow(def, args, {
    ...opts,
    runId: job.runId,
    onEvent: (e) => {
      if (e.type === "phase") job.phase = e.title;
      const line = describe(e);
      if (line === undefined) return opts.onEvent?.(e);
      job.recent = [...job.recent, line].slice(-20);
      writeJob(opts.cwd, job);
      opts.onEvent?.(e);
    },
  }).then((outcome) => {
    Object.assign(job, {
      status: outcome.status,
      result: outcome.result,
      error: outcome.error,
      spentCents: outcome.spentCents,
      chargedCents: outcome.chargedCents,
      spentTokens: outcome.spentTokens,
      usage: outcome.usage,
      finishedAt: new Date().toISOString(),
    });
    writeJob(opts.cwd, job);
    activeJobs.delete(job.jobId);
    return job;
  });
  return { job, done };
}

/** Espera até `timeoutMs` pelo fim do job; devolve o estado atual (terminado ou não). */
export async function waitJob(cwd: string, jobId: string, timeoutMs: number): Promise<JobState | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = readJob(cwd, jobId);
    if (!job || job.status !== "running" || Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
