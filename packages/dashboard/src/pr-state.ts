// The state of the GitHub pull requests the Board's cards link to, asked of the `gh` CLI (which holds the user's login) and
// kept in a short-lived cache, so a board that polls every few seconds stays current without hammering GitHub.
//
// - It never makes a caller wait: `states()` answers with what it knows now and asks `gh` in the background for what it does
//   not know or what has gone old, a few at a time. A state not known yet shows up on a later poll.
// - Only the exact URL of a pull request on github.com goes to `gh`, as one argument of a fixed command line (no shell). A
//   URL comes from a workflow's log: it is never allowed to be an option or another host's address.
// - An answer is kept for `cacheMs` while the pull request is open (the state can change any minute), 120 times that once it
//   is merged or closed (it rarely does), and 10 times that when `gh` could not answer (no login, no network, no such pull
//   request), so a missing `gh` costs a failed start now and then, not one per poll.
// - A refresh that fails keeps the state it had.
import { execFile } from "node:child_process";
/** How GitHub says a pull request stands. */
export type PrState = "open" | "merged" | "closed";

/** A pull request of github.com, exactly: no query, no fragment, no path after the number. */
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d{1,9}$/;
export const isPullRequestUrl = (url: string): boolean => PR_URL.test(url);

const GH_TIMEOUT_MS = 10_000;
/** How many `gh` processes run at once. */
const MAX_PARALLEL = 4;
/** How many pull requests the cache remembers. The oldest answer goes first. */
const MAX_ENTRIES = 1000;
const STATES: Record<string, PrState> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

interface Entry {
  state?: PrState;
  at: number;
  ttlMs: number;
}

export class PrStates {
  private readonly entries = new Map<string, Entry>();
  /** Queued or being asked: a URL is asked once at a time. */
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly stopping = new AbortController();

  constructor(private readonly cacheMs: number) {}

  /** The state of each pull request URL in `urls` that is known now. Asks `gh`, in the background, about those not known or gone old. */
  states(urls: Iterable<string>): Map<string, PrState> {
    const known = new Map<string, PrState>();
    const now = Date.now();
    for (const url of urls) {
      if (!isPullRequestUrl(url) || known.has(url)) continue;
      const entry = this.entries.get(url);
      if (entry?.state) known.set(url, entry.state);
      if ((!entry || now - entry.at >= entry.ttlMs) && !this.pending.has(url)) {
        this.pending.add(url);
        this.queue.push(url);
      }
    }
    this.pump();
    return known;
  }

  /** Stops asking: nothing more is started, and what is running is ended. */
  close(): void {
    this.stopping.abort();
    this.queue.length = 0;
  }

  private pump(): void {
    while (this.running < MAX_PARALLEL && this.queue.length > 0 && !this.stopping.signal.aborted) {
      const url = this.queue.shift()!;
      this.running++;
      void this.ask(url).then((state) => {
        this.running--;
        this.pending.delete(url);
        if (!this.stopping.signal.aborted) this.record(url, state);
        this.pump();
      });
    }
  }

  private record(url: string, state: PrState | undefined): void {
    const kept = this.entries.get(url)?.state;
    const ttlMs = state === undefined ? this.cacheMs * 10 : state === "open" ? this.cacheMs : this.cacheMs * 120;
    this.entries.delete(url); // re-inserted: the Map's order is the order of the latest answers
    this.entries.set(url, { state: state ?? kept, at: Date.now(), ttlMs });
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  /** `gh pr view <url> --json state --jq .state`, or undefined when gh could not answer. */
  private ask(url: string): Promise<PrState | undefined> {
    return new Promise((resolve) => {
      execFile(
        "gh",
        ["pr", "view", url, "--json", "state", "--jq", ".state"],
        { timeout: GH_TIMEOUT_MS, signal: this.stopping.signal, maxBuffer: 4096, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } },
        (err, stdout) => resolve(err ? undefined : STATES[stdout.trim()]),
      );
    });
  }
}
