// What the dashboard's Backlog says to the browser, and how often it asks the forge for it. The Backlog is the open issues, of
// every repository the runs index names, that carry the backlog label and that no run of `implement-issue` has taken on
// (`GET /api/backlog`). The runtime reads them through the forge seam (`readBacklog`, observe); this module turns what it answers
// into the reply, and keeps each repository's answer for a while so that a board that polls does not call `gh` or `glab` on every poll.
//
// - `Backlogs` keeps the forge's answer, a list or an error, for `cacheMs` per repository, and asks a repository once at a time: a
//   request that comes while the forge is being asked waits for that answer. At most `MAX_PARALLEL` repositories are asked at once, so
//   a machine with many repositories never starts a `gh` or a `glab` for each of them together. The runs are not kept: `backlogReply` takes the issues
//   that have a run off the list on every request, so a run started a moment ago drops its card at once.
// - `backlogReply` is pure. A repository the forge could not answer is an entry of `errors` with the reason; the others still list.
import { type BacklogRead, BACKLOG_WORKFLOW, readBacklog } from "@cursor-workflows/runtime/observe";

/** An issue of the Backlog, as the column's card shows it. */
export interface BacklogCard {
  repo: string;
  issue: number;
  title: string;
  /** The issue's page, when its address is an http or https one. */
  url?: string;
}

/** What `GET /api/backlog` answers: the cards, oldest issue first within each repository, and the repositories the forge could not answer for. */
export interface BacklogReply {
  /** The workflow a card's "run" starts: the one whose runs take an issue off the Backlog. The browser starts it with `{ issue: <number> }`. */
  workflow: string;
  cards: BacklogCard[];
  errors: Array<{ repo: string; error: string }>;
}

/** One repository's answer, and the issues of it that already have a run. */
export interface BacklogReading {
  repo: string;
  read: BacklogRead;
  taken: ReadonlySet<number>;
}

/** `url` when it is the address of a web page, and nothing otherwise: a link is never a `javascript:` or `data:` one. */
function webUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The reply for `readings`, in the order of the repositories. */
export function backlogReply(readings: readonly BacklogReading[]): BacklogReply {
  const cards: BacklogCard[] = [];
  const errors: BacklogReply["errors"] = [];
  for (const { repo, read, taken } of readings) {
    if (read.kind === "failed") {
      errors.push({ repo, error: read.error });
      continue;
    }
    for (const { number, title, url } of read.issues) {
      if (taken.has(number)) continue;
      const link = webUrl(url);
      cards.push({ repo, issue: number, title, ...(link === undefined ? {} : { url: link }) });
    }
  }
  return { workflow: BACKLOG_WORKFLOW, cards, errors };
}

/** How many forge CLI processes run at once (as in pr-state.ts). */
const MAX_PARALLEL = 4;

interface Entry {
  read: BacklogRead;
  at: number;
}

export class Backlogs {
  private readonly entries = new Map<string, Entry>();
  /** The repositories being asked now, each with the answer on its way. */
  private readonly asking = new Map<string, Promise<BacklogRead>>();
  /** How many repositories are being asked, and who waits for a place among them. */
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private closed = false;

  /** `cacheMs`: how long an answer, a list or an error, is kept before the forge is asked again. */
  constructor(private readonly cacheMs: number) {}

  /** The forge's answer for `repo`: the one kept, while it is not old, or a new one (asked once, however many are waiting for it). */
  read(repo: string): Promise<BacklogRead> {
    const entry = this.entries.get(repo);
    if (entry && Date.now() - entry.at < this.cacheMs) return Promise.resolve(entry.read);
    let asking = this.asking.get(repo);
    if (!asking) {
      asking = this.limited(() => readBacklog(repo))
        .then((read) => {
          if (!this.closed) this.entries.set(repo, { read, at: Date.now() });
          return read;
        })
        .finally(() => this.asking.delete(repo));
      this.asking.set(repo, asking);
    }
    return asking;
  }

  /** Runs `ask` when fewer than `MAX_PARALLEL` are running: a finished one hands its place to the next in line, so the count never goes over. */
  private async limited<T>(ask: () => Promise<T>): Promise<T> {
    if (this.running < MAX_PARALLEL) this.running++;
    else await new Promise<void>((place) => this.waiting.push(place));
    try {
      return await ask();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  /** Stops keeping answers: one that arrives after this is handed to those waiting for it and forgotten. */
  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}
