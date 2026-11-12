// The actions of the Run view's header: cancel a running or frozen run, cancel the cloud agents a run whose process is gone
// left working, and copy the command that resumes one that stopped.
import { useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard.js";
import { ARGS_PLACEHOLDER, canResume, resumeCommand } from "./resume-command.js";
import { cancelResult, cancelRun } from "./run-actions.js";
import type { OfferedActions } from "./run-status.js";
import type { ApiStatus, RunInfo } from "./use-run-events.js";

type CancelState = { step: "idle" } | { step: "confirm" } | { step: "sending" } | { step: "done"; message: string } | { step: "failed"; message: string };

export interface RunActionsProps {
  runId: string;
  status?: ApiStatus;
  /** What the header offers (see `offeredActions`). */
  offered: OfferedActions;
  info?: RunInfo;
  /** The `argsHash` of the run's latest execution (see `argsHashOf`). */
  argsHash?: string;
  /** Asks the feed to look at the run's status now. */
  onChanged(): void;
}

export function RunActions({ runId, status, offered, info, argsHash, onChanged }: RunActionsProps) {
  const [cancel, setCancel] = useState<CancelState>({ step: "idle" });
  const [copied, setCopied] = useState<"yes" | "no">();
  const [shown, setShown] = useState(false);

  // A resume puts a cancelled run back to running: it can be cancelled again, so what the last cancel said is forgotten.
  const before = useRef(status);
  useEffect(() => {
    if (status === "running" && before.current !== "running") setCancel({ step: "idle" });
    before.current = status;
  }, [status]);

  const cloudOnly = !offered.cancelRun && offered.leftCloudAgents.length > 0;
  const send = async () => {
    setCancel({ step: "sending" });
    const outcome = await cancelRun(runId);
    onChanged();
    setCancel(cancelResult(outcome, cloudOnly));
  };

  const command = info && canResume(status) ? resumeCommand({ workflow: info.workflow, runId, repo: info.repo, argsHash, start: info.start }) : undefined;
  const copy = async () => {
    if (!command) return;
    setShown(true);
    setCopied((await copyText(command)) ? "yes" : "no");
  };

  const agents = offered.leftCloudAgents;
  const offerCancel = (offered.cancelRun || cloudOnly) && cancel.step !== "done";
  return (
    <div className="actions">
      {offerCancel && (
        <>
          {(cancel.step === "idle" || cancel.step === "failed") && (
            <button
              type="button"
              className="btn danger"
              title={
                cloudOnly
                  ? `The process of this run stopped while ${agents.join(", ")} worked in the cloud: ${agents.length > 1 ? "they" : "it"} may still be running, and spending`
                  : offered.frozen
                    ? "The process of this run stopped beating: cancelling kills it, without undoing the step in progress, and cancels the cloud agents it left; a resume afterwards starts new ones, at new cost"
                    : undefined
              }
              onClick={() => setCancel({ step: "confirm" })}
            >
              {cloudOnly ? (agents.length > 1 ? `Cancel ${agents.length} cloud agents` : "Cancel cloud agent") : "Cancel run"}
            </button>
          )}
          {cancel.step === "confirm" && (
            <span
              className="confirm"
              role="group"
              aria-label={cloudOnly ? "Confirm cancelling the cloud agents" : "Confirm cancelling the run"}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation(); // Escape here means "keep running", not "close the log panel"
                setCancel({ step: "idle" });
              }}
            >
              {cloudOnly ? `Stop ${agents.join(", ")} in the cloud?` : "Stop this run?"}
              <button type="button" className="btn danger" onClick={() => void send()}>
                Yes, cancel
              </button>
              <button type="button" className="btn" onClick={() => setCancel({ step: "idle" })}>
                {cloudOnly || offered.frozen ? "Keep" : "Keep running"}
              </button>
            </span>
          )}
          {cancel.step === "sending" && (
            <button type="button" className="btn" disabled>
              Cancelling…
            </button>
          )}
        </>
      )}
      {(cancel.step === "done" || cancel.step === "failed") && (
        <span className={`cancel-result ${cancel.step}`} role={cancel.step === "failed" ? "alert" : "status"}>
          {cancel.message}
        </span>
      )}
      {command !== undefined && (
        <>
          <button type="button" className="btn" onClick={() => void copy()}>
            Copy resume command
          </button>
          {copied === "yes" && (
            <span className="copied" role="status">
              Copied.
            </span>
          )}
          {copied === "no" && (
            <span className="cancel-result failed" role="alert">
              The browser did not allow copying: select the command and copy it.
            </span>
          )}
          {shown && (
            <>
              <input className="command" readOnly aria-label="Resume command" value={command} onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.currentTarget.select()} />
              <span className="hint">
                {info?.start
                  ? "The same args and limits as the run's latest start."
                  : (command.includes(ARGS_PLACEHOLDER) ? "No job record says how this run was started, and its log keeps only a hash of the args: put the args of the first start in place of the placeholder. " : "") +
                    "Add the same --max-cents and --max-tokens if the first start had them."}
              </span>
            </>
          )}
        </>
      )}
    </div>
  );
}
