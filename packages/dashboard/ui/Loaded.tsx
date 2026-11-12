// What a view that polls shows around its data: a loading line before the first answer, the error if there is none yet, and
// a banner when a later poll fails while the last answer stays on screen.
import type { ReactNode } from "react";
import type { Polled } from "./usePoll.js";

export function Loaded<T>({ poll, what, children }: { poll: Polled<T>; what: string; children: (data: T) => ReactNode }) {
  if (!poll.data) return <p className={poll.error ? "note error" : "note"}>{poll.error ?? `Loading ${what}…`}</p>;
  return (
    <>
      {poll.error && <p className="note error">Could not refresh: {poll.error}</p>}
      {children(poll.data)}
    </>
  );
}
