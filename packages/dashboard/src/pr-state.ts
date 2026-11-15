// The state of the GitHub pull requests and GitLab merge requests the Board's cards link to, asked of the forge's CLI (`gh`,
// `glab`: they hold the user's login) through the runtime's `observe` entry point, and kept in a short-lived cache, so a board that
// polls every few seconds stays current without hammering the forge.
//
// - It never makes a caller wait: `states()` answers with what it knows now and asks in the background for what it does not know or
//   what has gone old, a few at a time. A state not known yet shows up on a later poll.
// - Only a URL that is exactly the address of a PR or an MR is asked about, and the runtime decides whether its host may be asked
//   (`prStateOfUrl`): a URL comes from a workflow's log, so it is never allowed to be an option or an arbitrary host's address.
// - An answer is kept for `cacheMs` while the PR is open (the state can change any minute), 120 times that once it is merged or
//   closed (it rarely does), and 10 times that when the forge could not answer (no login, no network, no such PR, a host not
//   allowed), so a missing CLI costs a failed start now and then, not one per poll.
// - A refresh that fails keeps the state it had.
import { type ForgePrState, isPrUrl, prStateOfUrl } from "@cursor-workflows/runtime/observe";
import { FORGE_CLI_PARALLEL, Limiter } from "./limiter.js";

/** How a forge says a PR or MR stands, in lower case as the Board's API and page spell it (the runtime's `ForgePrState` is upper case). */
export type PrState = "open" | "merged" | "closed";

/** How many PRs the cache remembers. The oldest answer goes first. */
const MAX_ENTRIES = 1000;
/** A total record: a state the runtime learns to report is a compile error here. */
const STATES: Record<ForgePrState, PrState> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

interface Entry {
  state?: PrState;
  at: number;
  ttlMs: number;
}

export class PrStates {
  private readonly entries = new Map<string, Entry>();
  /** Queued or being asked: a URL is asked once at a time. */
  private readonly pending = new Set<string>();
  /** How many PRs are asked at once. */
  private readonly limiter = new Limiter(FORGE_CLI_PARALLEL);
  private readonly stopping = new AbortController();

  constructor(private readonly cacheMs: number) {}

  /** The state of each PR or MR URL in `urls` that is known now. Asks the forge, in the background, about those not known or gone old. */
  states(urls: Iterable<string>): Map<string, PrState> {
    const known = new Map<string, PrState>();
    const now = Date.now();
    for (const url of urls) {
      if (!isPrUrl(url) || known.has(url)) continue;
      const entry = this.entries.get(url);
      if (entry?.state) known.set(url, entry.state);
      if ((!entry || now - entry.at >= entry.ttlMs) && !this.pending.has(url) && !this.stopping.signal.aborted) {
        this.pending.add(url);
        void this.limiter.run(() => this.ask(url)).then((state) => {
          this.pending.delete(url);
          if (!this.stopping.signal.aborted) this.record(url, state);
        });
      }
    }
    return known;
  }

  /** Stops asking: nothing more is started, and what is running is ended. */
  close(): void {
    this.stopping.abort();
  }

  private record(url: string, state: PrState | undefined): void {
    const kept = this.entries.get(url)?.state;
    const ttlMs = state === undefined ? this.cacheMs * 10 : state === "open" ? this.cacheMs : this.cacheMs * 120;
    this.entries.delete(url); // re-inserted: the Map's order is the order of the latest answers
    this.entries.set(url, { state: state ?? kept, at: Date.now(), ttlMs });
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  /** What the runtime says of `url`, or undefined when the forge could not answer. Nothing is asked once the cache is closed: a URL still in line is dropped. */
  private async ask(url: string): Promise<PrState | undefined> {
    if (this.stopping.signal.aborted) return undefined;
    const state = await prStateOfUrl(url, this.stopping.signal);
    return state && STATES[state];
  }
}
