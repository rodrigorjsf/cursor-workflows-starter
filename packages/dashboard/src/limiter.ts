// A cap on how many forge CLI processes (`gh`, `glab`) one part of the dashboard runs at once: the Backlog (backlog.ts) and the
// PR states of the Board (pr-state.ts) each hold one, so a board of many repositories or many PRs never starts a CLI for each of
// them together.

/** How many forge CLI processes one limiter runs at once. */
export const FORGE_CLI_PARALLEL = 4;

export class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** Runs `task` when fewer than `max` are running: a finished one hands its place to the next in line, so the count never goes over. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.max) this.running++;
    else await new Promise<void>((place) => this.waiting.push(place));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
