// The Runs menu: every run of every repo, newest first.
import type { RunSummary } from "@cursor-workflows/runtime/observe";
import { formatCents, repoName, runDuration, runHref, startedLabel } from "./format.js";
import { Loaded } from "./Loaded.js";
import { usePoll } from "./usePoll.js";

const POLL_MS = 3000;

export function RunsView() {
  const poll = usePoll<{ runs: RunSummary[] }>("/api/runs", POLL_MS);
  return (
    <Loaded poll={poll} what="the runs">
      {({ runs }) =>
        runs.length === 0 ? (
          <p className="note">No runs yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Run</th>
                  <th scope="col">Phase</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Repo</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId}>
                    <td>
                      <span className={`pill status-${run.status}`} title={run.error}>
                        {run.status}
                      </span>
                    </td>
                    <td>{run.workflow}</td>
                    <td>
                      {run.status === "missing" ? (
                        <code>{run.runId}</code>
                      ) : (
                        <a href={runHref(run.runId)} title="Open the run">
                          <code>{run.runId}</code>
                        </a>
                      )}
                    </td>
                    <td>{run.phase ?? ""}</td>
                    <td>{startedLabel(run.startedAt)}</td>
                    <td>{run.status === "missing" ? "" : runDuration(run.startedAt, run.finishedAt)}</td>
                    <td className="n">{formatCents(run.spentCents)}</td>
                    <td title={run.repo}>{repoName(run.repo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </Loaded>
  );
}
