// The actions of the Run view's header: cancel a running run, and copy the command that resumes one that stopped.
import { useState } from "react";
import { copyText } from "./clipboard.js";
import { canResume, resumeCommand } from "./resume-command.js";
import { cancelRun } from "./run-actions.js";
import type { ApiStatus, RunInfo } from "./use-run-events.js";

type CancelState = { step: "idle" } | { step: "confirm" } | { step: "sending" } | { step: "done"; message: string } | { step: "failed"; message: string };

export interface RunActionsProps {
  runId: string;
  status?: ApiStatus;
  info?: RunInfo;
  /** Asks the feed to look at the run's status now. */
  onChanged(): void;
}

export function RunActions({ runId, status, info, onChanged }: RunActionsProps) {
  const [cancel, setCancel] = useState<CancelState>({ step: "idle" });
  const [copied, setCopied] = useState<"yes" | "no">();
  const [shown, setShown] = useState(false);

  const send = async () => {
    setCancel({ step: "sending" });
    const outcome = await cancelRun(runId);
    onChanged();
    if (!outcome.ok) setCancel({ step: "failed", message: outcome.error });
    else setCancel({ step: "done", message: outcome.status === "cancelled" ? "Cancelled." : `Cancelling: ${outcome.note}` });
  };

  const command = info && canResume(status) ? resumeCommand({ workflow: info.workflow, runId, repo: info.repo }) : undefined;
  const copy = async () => {
    if (!command) return;
    setShown(true);
    setCopied((await copyText(command)) ? "yes" : "no");
  };

  return (
    <div className="actions">
      {status === "running" && cancel.step !== "done" && (
        <>
          {(cancel.step === "idle" || cancel.step === "failed") && (
            <button type="button" className="danger" onClick={() => setCancel({ step: "confirm" })}>
              Cancel run
            </button>
          )}
          {cancel.step === "confirm" && (
            <span className="confirm" role="group" aria-label="Confirm cancelling the run">
              Stop this run?
              <button type="button" className="danger" onClick={() => void send()}>
                Yes, cancel it
              </button>
              <button type="button" onClick={() => setCancel({ step: "idle" })}>
                Keep running
              </button>
            </span>
          )}
          {cancel.step === "sending" && (
            <button type="button" disabled>
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
          <button type="button" onClick={() => void copy()}>
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
            <input className="command" readOnly aria-label="Resume command" value={command} onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.currentTarget.select()} />
          )}
        </>
      )}
    </div>
  );
}
