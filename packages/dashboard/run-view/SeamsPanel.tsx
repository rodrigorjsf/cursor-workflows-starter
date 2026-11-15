// The panel of the Run view for an `implement-issue` run that stopped to ask about its seams: what the run proposes (the seams, the
// slices, the test command that approving lets it execute), and the two decisions a person can take, as the issue's comment offers them
// from a terminal: Approve (the run goes on with exactly this plan) and Replace seams (a list, one seam per line, and the run plans
// again with it). There is no reject: a proposal nobody approves is simply not resumed. Both decisions resume the run, and the workflow
// itself comments on the issue that they were taken; the dashboard posts nothing.
//
// Everything the proposal holds is model text, shown as React text and never as markup. Approve names the proposal this page showed (its
// digest), so a plan that changed since is refused by the server instead of approved unseen.
import { useState } from "react";
import { approveSeams, replaceSeams, resumeResult, type ResumeOutcome } from "./run-actions.js";
import { type SeamsProposalInfo, replacementOf } from "./seams-form.js";
import type { ApiStatus } from "./use-run-events.js";
import { useWaitForRunning } from "./use-wait-for-running.js";

type DecisionState =
  | { step: "idle" }
  | { step: "replacing"; text: string; error?: string }
  /** A decision is on its way. `text` is what a replacement sends, which the box keeps showing; an approval has none. */
  | { step: "sending"; text?: string }
  | { step: "started" }
  | { step: "failed"; message: string };

const TITLE: Record<SeamsProposalInfo["stop"], string> = {
  "seams-proposed": "Seams proposed",
  "test-command-proposed": "Test command proposed",
};

const INTRO: Record<SeamsProposalInfo["stop"], string> = {
  "seams-proposed":
    "The planner proposed these seams for the run. Approve them and the run goes on with exactly this plan, with the test command below; or replace the seams with your own, and the run plans again.",
  "test-command-proposed":
    "The run was started with seams and no test command, so the planner chose the command below. Nothing has run: approve it and the run goes on with exactly this plan, or replace the seams.",
};

export interface ReplaceBoxProps {
  text: string;
  /** Why the replacement was not sent: the box's own check, or the server's sentence. */
  error?: string;
  sending: boolean;
  onText(text: string): void;
  onSend(): void;
  onCancel(): void;
}

/** The box a replacement is typed in: one seam per line. */
export function ReplaceBox({ text, error, sending, onText, onSend, onCancel }: ReplaceBoxProps) {
  return (
    <div
      className="seams-replace"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation(); // Escape here means "keep the proposal as it is", not "close the log panel"
        onCancel();
      }}
    >
      <label htmlFor="seams-text">Seams, one per line</label>
      <textarea
        id="seams-text"
        rows={4}
        spellCheck={false}
        autoFocus
        value={text}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : "seams-error"}
        onChange={(event) => onText(event.target.value)}
      />
      {error !== undefined && (
        <p className="seams-error" role="alert" id="seams-error">
          {error}
        </p>
      )}
      <div className="seams-buttons">
        <button type="button" className="btn" disabled={sending} onClick={onSend}>
          {sending ? "Sending…" : "Send replacement"}
        </button>
        <button type="button" className="btn" disabled={sending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export interface SeamsPanelProps {
  runId: string;
  proposal: SeamsProposalInfo;
  status?: ApiStatus;
  /** Asks the feed to look at the run's status now. */
  onChanged(): void;
}

export function SeamsPanel({ runId, proposal, status, onChanged }: SeamsPanelProps) {
  const [state, setState] = useState<DecisionState>({ step: "idle" });
  // After a decision started a job, ask for the run's status until it shows `running`; if it never does (the job stopped at once), the buttons come back after a while.
  useWaitForRunning({ waiting: state.step === "started", running: status === "running", onChanged, onDone: () => setState({ step: "idle" }) });

  /** Sends a decision, then shows what came of it; `back` is where a refusal goes (the replacement box keeps what was typed). */
  const decide = async (sending: DecisionState, send: () => Promise<ResumeOutcome>, back: (message: string) => DecisionState) => {
    setState(sending);
    const result = resumeResult(await send());
    onChanged();
    setState(result.step === "started" ? result : back(result.message));
  };
  const approve = () => decide({ step: "sending" }, () => approveSeams(runId, proposal.digest), (message) => ({ step: "failed", message }));
  const sendReplacement = (text: string) => {
    const replacement = replacementOf(text);
    if (!replacement.ok) return setState({ step: "replacing", text, error: replacement.error });
    return decide({ step: "sending", text }, () => replaceSeams(runId, replacement.seams), (message) => ({ step: "replacing", text, error: message }));
  };

  const deciding = state.step === "idle" || state.step === "failed";
  return (
    <section className="seams-panel" aria-labelledby="seams-title">
      <h2 id="seams-title">{TITLE[proposal.stop]}</h2>
      {proposal.decidable ? (
        <p className="seams-intro">{INTRO[proposal.stop]}</p>
      ) : (
        <p className="seams-intro">
          The run waits for a decision on this proposal, but it was not started as a job (wf run in a terminal, or by an older kit), so the dashboard does not know the args to resume it with. The test command shown is the planner&apos;s: a
          command typed when the run started is not known here. Decide from the terminal, with the relaunch command of the seams comment on the issue.
        </p>
      )}
      <h3>Seams</h3>
      <ul className="seams-list">
        {proposal.seams.map((seam, index) => (
          <li key={index}>
            <strong>{seam.name}</strong> <code>{seam.interface}</code> <span className="seams-why">{seam.why}</span>
          </li>
        ))}
      </ul>
      <h3>Slices</h3>
      <ol className="seams-list">
        {proposal.slices.map((slice, index) => (
          <li key={index}>
            {slice.behavior} <span className="seams-why">(seam: {slice.seam}; test: {slice.testIdea})</span>
          </li>
        ))}
      </ol>
      <h3>Test command</h3>
      <pre className="seams-command">
        <code>{proposal.testCommand}</code>
      </pre>
      {proposal.decidable && deciding && (
        <div className="seams-buttons">
          <button type="button" className="btn" onClick={() => void approve()}>
            Approve
          </button>
          <button type="button" className="btn" onClick={() => setState({ step: "replacing", text: "" })}>
            Replace seams
          </button>
        </div>
      )}
      {state.step === "failed" && (
        <p className="seams-error" role="alert">
          {state.message}
        </p>
      )}
      {(state.step === "replacing" || (state.step === "sending" && state.text !== undefined)) && (
        <ReplaceBox
          text={state.text ?? ""}
          error={state.step === "replacing" ? state.error : undefined}
          sending={state.step === "sending"}
          onText={(text) => setState({ step: "replacing", text })}
          onSend={() => void sendReplacement(state.text ?? "")}
          onCancel={() => setState({ step: "idle" })}
        />
      )}
      {state.step === "sending" && state.text === undefined && (
        <p className="seams-result" role="status">
          Sending…
        </p>
      )}
      {state.step === "started" && (
        <p className="seams-result" role="status">
          Decision sent: a job over this run started; the page follows it.
        </p>
      )}
    </section>
  );
}
