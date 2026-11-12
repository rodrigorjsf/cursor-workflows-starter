// Journal append-only por run: permite retomar um workflow sem repetir etapas já concluídas.
//
// Diferença consciente em relação ao Claude Code: lá o cache é "o maior prefixo inalterado de agent()
// na ordem de início". Aqui a chave é hash(prompt + opções relevantes) + nº da ocorrência desse hash,
// o que tolera reordenação causada por pipeline() (ordem de conclusão varia entre execuções).
// Consequência: editar o prompt de uma etapa só reexecuta aquela etapa e as que dependem do novo
// resultado (porque o prompt delas muda) — não "tudo depois dela".

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  key: string;
  label?: string;
  model?: string;
  result: unknown;
  chargedCents: number;
  totalTokens: number;
}

export class Journal {
  private readonly cache = new Map<string, JournalEntry>();
  private readonly occurrences = new Map<string, number>();

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as JournalEntry;
        this.cache.set(entry.key, entry);
      }
    }
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
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
  }
}
