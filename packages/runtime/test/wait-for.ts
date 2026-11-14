// Shared by the tests that wait for something a run, a process or a server does in the background. A fixed sleep before an
// assertion passes on an idle machine and fails on a loaded one; polling the condition with a deadline does not
// (test/fixed-waits.test.ts keeps it that way).

export interface WaitForOptions {
  /** How long to keep polling before failing. Generous by default: a loaded CI machine is slow, and a pass returns at once. */
  timeoutMs?: number;
  /** How long to sleep between two polls. */
  intervalMs?: number;
}

/**
 * Polls `read` until it returns a truthy value, and resolves with that value. Fails, naming `what`, once `timeoutMs` has
 * passed without one. `read` may be async; an error it throws ends the wait.
 */
export async function waitFor<T>(what: string, read: () => T | Promise<T>, { timeoutMs = 30_000, intervalMs = 20 }: WaitForOptions = {}): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
