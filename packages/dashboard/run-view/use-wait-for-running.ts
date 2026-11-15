// The wait after a click that started a job over a stopped run (the header's Resume, the seams panel's Approve and Replace). The job's
// process needs a moment to start, and the page looks at a stopped run only rarely: while it waits, the page asks the feed for the run's
// status every second, until the run shows `running`, and stops waiting after half a minute (a job that stopped at once, with the
// run as it was). Hook only: the state it serves belongs to the caller.
import { useEffect, useRef } from "react";

/** How often the page looks at the run's status while it waits, and how long it waits for the run to show `running`, in milliseconds. */
const LOOK_MS = 1000;
const GIVE_UP_MS = 30_000;

export interface WaitForRunning {
  /** A job was just started over the run, and the page waits for it to show. */
  waiting: boolean;
  /** The run's status is `running` now. */
  running: boolean;
  /** Asks the feed to look at the run's status now. */
  onChanged(): void;
  /** Called when the wait is over: the run is running, or the wait gave up. */
  onDone(): void;
}

export function useWaitForRunning({ waiting, running, onChanged, onDone }: WaitForRunning): void {
  // Read through refs, so that a new function each render does not restart the wait.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!waiting) return;
    if (running) {
      done.current();
      return;
    }
    const look = setInterval(() => changed.current(), LOOK_MS);
    const giveUp = setTimeout(() => done.current(), GIVE_UP_MS);
    return () => {
      clearInterval(look);
      clearTimeout(giveUp);
    };
  }, [waiting, running]); // not `onChanged` or `onDone`: see the refs above
}
