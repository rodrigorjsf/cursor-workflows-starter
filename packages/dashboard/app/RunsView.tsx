// The Runs menu: every run of every repo, newest first. A table on a wide screen; on a narrow one each row stacks into a card
// whose cells say which column they are (`data-label`), so nothing hides in a sideways scroll.
import type { RunSummary } from "@cursor-workflows/runtime/observe";
import { formatCents, formatCount, repoName, runDuration, runHref, startedLabel } from "./format.js";
import { Empty, Loaded, PageHeader } from "./Loaded.js";
import { usePoll } from "./usePoll.js";

const POLL_MS = 3000;

export function RunsView() {
  const poll = usePoll<{ runs: RunSummary[] }>("/api/runs", POLL_MS);
  return (
    <>
      <PageHeader title="Runs" summary={poll.data ? runsSummary(poll.data.runs) : undefined} />
      <Loaded poll={poll} what="the runs">
        {({ runs }) => <RunsTable runs={runs} />}
      </Loaded>
    </>
  );
}

/** `12 runs · 2 running · 1 failed`: the count, then the statuses that ask for attention. */
export function runsSummary(runs: RunSummary[]): string {
  const count = (status: string) => runs.filter((run) => run.status === status).length;
  const parts = [`${formatCount(runs.length)} ${runs.length === 1 ? "run" : "runs"}`];
  for (const status of ["running", "failed"]) if (count(status) > 0) parts.push(`${formatCount(count(status))} ${status}`);
  return parts.join(" · ");
}

export function RunsTable({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return (
      <Empty title="No runs yet">
        Start a workflow from the chat or with <code>npm run wf -- start &lt;workflow&gt;</code>, and it shows up here.
      </Empty>
    );
  }
  return (
    <div className="table-card">
      <table className="data runs">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Run</th>
            <th scope="col">Phase</th>
            <th scope="col">Started</th>
            <th scope="col" className="n">
              Duration
            </th>
            <th scope="col" className="n">
              Cost
            </th>
            <th scope="col">Repo</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId} className={`status-${run.status}`}>
              <td data-label="Status" className="run-status">
                <span className={`pill status-${run.status}`}>{run.status}</span>
              </td>
              <td data-label="Run" className="run-main">
                <div className="run-cell">
                  <span className="workflow">{run.workflow}</span>
                  {run.status === "missing" ? (
                    <code className="run-id">{run.runId}</code>
                  ) : (
                    <a className="run-id" href={runHref(run.runId)} title="Open the run">
                      <code>{run.runId}</code>
                    </a>
                  )}
                  {run.error && (run.status === "failed" || run.status === "missing" || run.status === "cancelled") && (
                    <span className={`reason${run.status === "cancelled" ? " muted" : ""}`} title={run.error}>
                      {run.error}
                    </span>
                  )}
                </div>
              </td>
              <td data-label="Phase">{run.phase ?? <span className="none">—</span>}</td>
              <td data-label="Started">
                <time dateTime={run.startedAt}>{startedLabel(run.startedAt)}</time>
              </td>
              <td data-label="Duration" className="n">
                {run.finishedAt !== undefined || run.status === "running" ? runDuration(run.startedAt, run.finishedAt) : <span className="none" title="The run did not record its end">—</span>}
              </td>
              <td data-label="Cost" className="n">
                {formatCents(run.spentCents)}
              </td>
              <td data-label="Repo" title={run.repo}>
                {repoName(run.repo)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
