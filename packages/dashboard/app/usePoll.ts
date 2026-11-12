// Reads a JSON route again and again. A view that polls keeps showing its last answer while the next one is on its way, and
// when a poll fails; it says so instead of going blank.
import { useEffect, useState } from "react";

export interface Polled<T> {
  /** The latest answer. Undefined until the first one arrives. */
  data?: T;
  /** Why the latest poll failed. Cleared by the next that works. */
  error?: string;
}

export function usePoll<T>(path: string, intervalMs: number): Polled<T> {
  const [state, setState] = useState<Polled<T>>({});
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const abort = new AbortController();
    const poll = async () => {
      if (!document.hidden) {
        try {
          const reply = await fetch(path, { signal: abort.signal });
          if (!reply.ok) throw new Error(`${path} answered ${reply.status}`);
          const data = (await reply.json()) as T;
          if (!stopped) setState({ data });
        } catch (err) {
          if (!stopped) setState((previous) => ({ data: previous.data, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      if (!stopped) timer = window.setTimeout(poll, intervalMs);
    };
    void poll();
    return () => {
      stopped = true;
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [path, intervalMs]);
  return state;
}
