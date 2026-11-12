// Jobs: execução assíncrona com estado em disco, para que o chat do Cursor dispare um workflow
// longo e consulte o resultado depois (MCP e shell do agente têm timeouts; um workflow de
// implementação leva minutos). CLI e MCP leem o mesmo diretório, então um job iniciado por um
// pode ser consultado pelo outro.
//
// O registro do job (`.workflows/jobs/<jobId>.json`) guarda só a identidade: id do job, id do run, pid e heartbeat.
// Todo o resto (status, fase, últimas linhas, gasto, resultado) é uma projeção do log de eventos do run
// (`.workflows/runs/<runId>/events.jsonl`), calculada a cada leitura: há uma fonte de verdade e nenhum arquivo de
// estado para ficar pela metade.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type RunOptions, newRunId, runWorkflow } from "./engine.js";
import { type ExecutionState, type Ledger, projectExecution, replayLedger, withRatio } from "./projection.js";
import { abortOpenRuns, eventLogPath, readEventLog } from "./run-store.js";
import { stateDir } from "./state.js";
import { writeFileAtomic } from "./state-files.js";
import type { WorkflowDefinition } from "./workflow.js";

/** O que fica em disco: a identidade do job. */
export interface JobRecord {
  jobId: string;
  /** Gravado no início: permite retomar com o mesmo journal mesmo se o processo morrer. */
  runId: string;
  /** Processo que executa o job; usado para detectar job órfão. */
  pid: number;
  /** Último instante em que o processo do job se declarou vivo (ISO 8601). */
  heartbeat: string;
  /**
   * Só quando o runtime recusou o job antes de o run começar (argumentos inválidos, run já em execução): o motivo. O log do
   * run não é do job nesse caso (pode ser de outra execução), então o motivo fica aqui.
   */
  refused?: string;
}

/** O que `wf status`, `wf jobs`, `get_workflow_status` e `wait_workflow` devolvem: o registro mais a projeção do log. */
export interface JobState {
  jobId: string;
  runId: string;
  pid: number;
  heartbeat: string;
  /** `meta.name` do workflow. Ausente enquanto o processo do job não começou o run. */
  workflow?: string;
  status: "running" | "finished" | "failed";
  startedAt?: string;
  finishedAt?: string;
  phase?: string;
  /** As últimas linhas de progresso, uma linha cada. Nunca texto de prompt ou de saída de agente. */
  recent: string[];
  result?: unknown;
  error?: string;
  /** Custo que o teto usa: Σ max(bruto, cobrado). Acumula entre resumes. */
  spentCents: number;
  /** Só o cobrado (0 para uso incluído no plano). */
  chargedCents: number;
  spentTokens: number;
  usage: Ledger["usage"] & { cacheHitRatio: number | null };
}

/** De quanto em quanto tempo um processo de job atualiza o heartbeat do registro. */
export const HEARTBEAT_MS = 5_000;

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

/** O registro do job em disco (só a identidade), sem a projeção. */
export function readJobRecord(cwd: string, jobId: string): JobRecord | undefined {
  const file = join(jobsDir(cwd), `${jobId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JobRecord;
  } catch {
    return undefined; // não é um registro que este runtime escreveu
  }
}

const unfinished = (record: JobRecord): string => `processo ${record.pid} terminou sem concluir o job; relance com resumeRunId="${record.runId}"`;

/** O estado do job: o registro e a projeção do log do run. Só lê. */
function project(cwd: string, record: JobRecord): JobState {
  const { events } = readEventLog(eventLogPath(cwd, record.runId), { content: false });
  const execution: ExecutionState | undefined = projectExecution(events, record.jobId);
  const ledger = execution?.ledger ?? replayLedger(events);
  const state: JobState = {
    jobId: record.jobId,
    runId: record.runId,
    pid: record.pid,
    heartbeat: record.heartbeat,
    workflow: execution?.workflow,
    status: execution?.status ?? "running",
    startedAt: execution?.startedAt,
    finishedAt: execution?.finishedAt,
    phase: execution?.phase,
    recent: execution?.recent ?? [],
    result: execution?.result,
    error: execution?.error,
    spentCents: ledger.spentCents,
    chargedCents: ledger.chargedCents,
    spentTokens: ledger.spentTokens,
    usage: withRatio(ledger.usage),
  };
  if (record.refused !== undefined) {
    state.status = "failed";
    state.error = record.refused;
  } else if (state.status === "running" && !isAlive(record.pid)) {
    // O processo morreu sem fechar o run (crash, reinício do MCP server, máquina desligada).
    state.status = "failed";
    state.error = unfinished(record);
  }
  return state;
}

export function readJob(cwd: string, jobId: string): JobState | undefined {
  const record = readJobRecord(cwd, jobId);
  return record && project(cwd, record);
}

export function listJobs(cwd: string): JobState[] {
  return readdirSync(jobsDir(cwd))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJob(cwd, f.slice(0, -5)))
    .filter((j): j is JobState => Boolean(j));
}

/** Grava o registro. Só os campos de identidade vão para o disco, mesmo que `record` seja um `JobState`. */
export function writeJob(cwd: string, record: JobRecord): void {
  const { jobId, runId, pid, heartbeat, refused } = record;
  writeFileAtomic(join(jobsDir(cwd), `${jobId}.json`), JSON.stringify({ jobId, runId, pid, heartbeat, ...(refused === undefined ? {} : { refused }) }, null, 2));
}

/** Cria o registro do job antes de rodar (CLI `start` grava no pai, antes do spawn). */
export function createJob(cwd: string, workflow: string, runId?: string, jobId: string = randomUUID().slice(0, 8), pid = process.pid): JobRecord {
  // Data/hora ficam no registro, não no workflow: o script precisa ser determinístico para o resume.
  const record: JobRecord = { jobId, runId: runId ?? newRunId(workflow), pid, heartbeat: new Date().toISOString() };
  writeJob(cwd, record);
  return record;
}

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
    // O estado do job vem do log do run: fecha os runs deste processo nele, com o motivo e o jeito de retomar.
    abortOpenRuns((runId) => `crash: ${err.message}; relance com resumeRunId="${runId}"`);
    process.stderr.write(`[wf] uncaughtException: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}

/** Roda o workflow no processo atual para um job já criado (ou cria um). `done` resolve com o estado final do job. */
export function startJob<A>(
  def: WorkflowDefinition<A, unknown>,
  args: A,
  opts: RunOptions,
  existing?: JobRecord,
): { job: JobRecord; done: Promise<JobState> } {
  const job = existing ?? createJob(opts.cwd, def.meta.name, opts.runId);
  const beat = () => {
    job.pid = process.pid;
    job.heartbeat = new Date().toISOString();
    writeJob(opts.cwd, job);
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref();
  const done = runWorkflow(def, args, { ...opts, runId: job.runId, jobId: job.jobId })
    .then((outcome) => {
      if (outcome.status === "failed" && outcome.refused) {
        job.refused = outcome.error;
        writeJob(opts.cwd, job);
      }
    })
    .finally(() => clearInterval(heartbeat))
    .then(() => readJob(opts.cwd, job.jobId)!);
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
