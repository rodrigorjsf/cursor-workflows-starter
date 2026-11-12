// Abertura do banco de métricas por usuário (SQLite via node:sqlite, sem dependência nova).
//
// - Caminho: $WF_METRICS_DB ou ~/.cursor-workflows/metrics.db ($WF_HOME muda o diretório; dir 0700, arquivo 0600).
// - WAL + busy_timeout: MCP server e jobs destacados escrevem ao mesmo tempo. WAL não funciona bem em disco de
//   rede nem em /mnt/c no WSL: mantenha o banco no disco local (o default em ~ atende).
// - `node:sqlite` é carregado por import dinâmico só quando métricas estão ligadas, e só o ExperimentalWarning
//   dele é filtrado (stderr do MCP server fica limpo; outros avisos continuam aparecendo).

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { userDir } from "../runtime/state.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export type Db = import("node:sqlite").DatabaseSync;

export function metricsEnabled(): boolean {
  return process.env.WF_METRICS !== "off";
}

export function defaultDbPath(): string {
  return process.env.WF_METRICS_DB ?? join(userDir(), "metrics.db");
}

let warningFilterInstalled = false;
function filterSqliteWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const previous = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
    if (previous.length) for (const l of previous) l(w);
    else process.stderr.write(`${w.name}: ${w.message}\n`);
  });
}

/** Executa `fn` numa transação de escrita curta (BEGIN IMMEDIATE espera o lock em vez de falhar). */
export function write<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export async function openDb(path = defaultDbPath(), opts: { readOnly?: boolean } = {}): Promise<Db> {
  filterSqliteWarning();
  const { DatabaseSync } = await import("node:sqlite");
  if (opts.readOnly) {
    if (!existsSync(path)) throw new Error(`metrics database not found: ${path}`);
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows / FS sem permissões POSIX */
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current < SCHEMA_VERSION) {
    write(db, () => {
      // Relê dentro do lock: outro processo pode ter migrado enquanto esperávamos.
      const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      for (let n = v + 1; n <= SCHEMA_VERSION; n++) db.exec(MIGRATIONS[n]!);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
  return db;
}
