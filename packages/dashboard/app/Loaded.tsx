// What every view shows around its data: a header (title, a one-line summary, controls), a loading state before the first
// answer, the error if there is none yet, and a banner when a later poll fails while the last answer stays on screen.
import type { ReactNode } from "react";
import type { Polled } from "./usePoll.js";

export function PageHeader({ title, summary, children }: { title: string; summary?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {summary !== undefined && <p className="summary">{summary}</p>}
      </div>
      {children !== undefined && <div className="page-actions">{children}</div>}
    </div>
  );
}

/** A view with nothing to show yet: what is missing, and how to get some. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children !== undefined && <p>{children}</p>}
    </div>
  );
}

export function Loaded<T>({ poll, what, children }: { poll: Polled<T>; what: string; children: (data: T) => ReactNode }) {
  if (!poll.data) {
    return poll.error ? (
      <p className="banner error" role="alert">
        Could not load {what}: {poll.error}
      </p>
    ) : (
      <p className="loading" role="status">
        Loading {what}…
      </p>
    );
  }
  return (
    <>
      {poll.error && (
        <p className="banner error" role="alert">
          Could not refresh: {poll.error}. Showing the last answer.
        </p>
      )}
      {children(poll.data)}
    </>
  );
}
