// Journal append-only por run: permite retomar um workflow sem repetir etapas já concluídas.
//
// Diferença consciente em relação ao Claude Code: lá o cache é "o maior prefixo inalterado de agent()
// na ordem de início". Aqui a chave é hash(prompt + opções relevantes) + nº da ocorrência desse hash,
// o que tolera reordenação causada por pipeline() (ordem de conclusão varia entre execuções).
// Consequência: editar o prompt de uma etapa só reexecuta aquela etapa e as que dependem do novo
// resultado (porque o prompt delas muda) — não "tudo depois dela".

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PRIVATE_DIR, appendJsonl, parseJsonlLine, readJsonl } from "./state-files.js";

export interface JournalEntry {
  key: string;
  label?: string;
  model?: string;
  /** The step's result. Absent from a pruned entry (`pruned`). */
  result: unknown;
  chargedCents: number;
  totalTokens: number;
  /** Retention deleted `result` (`withoutResults`): the entry keeps what the budget and the step list need, and cannot serve a resume. */
  pruned?: true;
}

const isEntry = (v: unknown): v is JournalEntry => typeof v === "object" && v !== null && typeof (v as { key?: unknown }).key === "string";

/**
 * The journal text with the `result` of every entry removed and every entry marked `pruned`, or undefined when every entry already
 * is. A journal holds the results of the run's steps, which are private source: retention (retention.ts) empties the journal of a
 * run that falls outside it. A line that is not an entry (a torn last line, which can hold the start of a result) is removed:
 * readers skip it, so it is of no use to a resume.
 */
export function withoutResults(journal: string): string | undefined {
  let changed = false;
  const lines = journal.split("\n").map((line) => {
    if (!line.trim()) return line;
    const entry = parseJsonlLine(line, isEntry);
    if (entry?.pruned) return line;
    changed = true;
    if (!entry) return "";
    const { result: _result, ...kept } = entry;
    return JSON.stringify({ ...kept, pruned: true });
  });
  return changed ? lines.join("\n") : undefined;
}

export class Journal {
  private readonly cache = new Map<string, JournalEntry>();
  private readonly occurrences = new Map<string, number>();
  /** Retention deleted the results this journal held (`withoutResults`): the run cannot be resumed from it. */
  readonly pruned: boolean;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: PRIVATE_DIR });
    // A torn line (crash mid-append) is skipped: the step it recorded is simply not in the journal, so it runs again.
    const { records } = readJsonl(file, isEntry);
    for (const entry of records) this.cache.set(entry.key, entry);
    this.pruned = records.some((entry) => entry.pruned === true);
  }

  /** Calcula a chave determinística da chamada. Deve ser chamado de forma síncrona no início de agent(). */
  keyFor(prompt: string, fingerprint: unknown): string {
    const base = createHash("sha256").update(prompt).update("\0").update(JSON.stringify(fingerprint)).digest("hex");
    const n = this.occurrences.get(base) ?? 0;
    this.occurrences.set(base, n + 1);
    return `${base}:${n}`;
  }

  get(key: string): JournalEntry | undefined {
    return this.cache.get(key);
  }

  record(entry: JournalEntry): void {
    this.cache.set(entry.key, entry);
    appendJsonl(this.file, entry);
  }
}
