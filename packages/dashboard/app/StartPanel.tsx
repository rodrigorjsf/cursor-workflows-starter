// The Start panel: pick a repository the dashboard knows, one of the workflows it lists, the args as JSON (pre-filled with a
// skeleton of what the workflow requires) and both caps, then start it as a job. The server decides what may start and says why
// not; the panel shows its sentence next to the form. A start that worked opens the run's page, where the run appears a moment
// later. `StartPanelView` is what is drawn from the data it is handed; `StartPanel` fetches that data and holds the form.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowsReply } from "../src/start.js";
import { repoName, runHref } from "./format.js";
import { Empty } from "./Loaded.js";
import { loadRepos, loadWorkflows, postStart } from "./start-api.js";
import { EMPTY_FORM, type StartFormState, argsTextOf, startBody } from "./start-form.js";

/** Something fetched: on its way, failed with a sentence, or here. */
export type Fetched<T> = { state: "loading" } | { state: "failed"; error: string } | { state: "ready"; value: T };

export interface StartPanelViewProps {
  repos: Fetched<string[]>;
  /** The chosen repository's workflows; undefined until a repository is chosen. */
  workflows?: Fetched<WorkflowsReply>;
  form: StartFormState;
  /** A start is on its way: the form waits for it. */
  sending: boolean;
  /** Why the last start did not start, as the server (or the form) said it. */
  error?: string;
  onRepo(repo: string): void;
  onWorkflow(name: string): void;
  onField(field: "argsText" | "maxTokens" | "maxCents", value: string): void;
  onSubmit(): void;
  onClose(): void;
}

export function StartPanelView({ repos, workflows, form, sending, error, onRepo, onWorkflow, onField, onSubmit, onClose }: StartPanelViewProps) {
  const listed = workflows?.state === "ready" ? workflows.value : undefined;
  const chosen = listed?.workflows.find((workflow) => workflow.name === form.workflow);
  return (
    <section className="start-panel" id="start-panel" aria-label="Start a workflow" tabIndex={-1}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2>Start a workflow</h2>
        {repos.state === "loading" && (
          <p className="loading" role="status">
            Loading the repositories…
          </p>
        )}
        {repos.state === "failed" && (
          <p className="banner error" role="alert">
            Could not load the repositories: {repos.error}
          </p>
        )}
        {repos.state === "ready" && repos.value.length === 0 && (
          <Empty title="No repository to start a workflow in">
            The dashboard starts workflows only in repositories it has seen a run of. Start one from the chat or with <code>npm run wf -- start &lt;workflow&gt;</code>, and the repository shows up here.
          </Empty>
        )}
        {repos.state === "ready" && repos.value.length > 0 && (
          <>
            <div className="start-grid">
              <label className="start-field">
                Repository
                <select value={form.repo} onChange={(event) => onRepo(event.target.value)}>
                  {repos.value.map((repo) => (
                    <option key={repo} value={repo}>
                      {repoName(repo)}
                    </option>
                  ))}
                </select>
                <span className="note">
                  <code>{form.repo}</code>
                </span>
              </label>
              <label className="start-field">
                Workflow
                <select value={form.workflow} disabled={listed === undefined || listed.workflows.length === 0} onChange={(event) => onWorkflow(event.target.value)}>
                  {listed?.workflows.map((workflow) => (
                    <option key={workflow.name} value={workflow.name}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
                {chosen && <span className="note">{chosen.whenToUse ?? chosen.description}</span>}
              </label>
            </div>
            {workflows?.state === "loading" && (
              <p className="loading" role="status">
                Loading the workflows…
              </p>
            )}
            {workflows?.state === "failed" && (
              <p className="banner error" role="alert">
                Could not load the workflows: {workflows.error}
              </p>
            )}
            {listed && listed.broken.length > 0 && (
              <p className="note" role="status">
                {listed.broken.length === 1 ? "1 workflow file" : `${listed.broken.length} workflow files`} of this repository did not load and {listed.broken.length === 1 ? "is" : "are"} not listed: {listed.broken.map((file) => file.file).join(", ")}.
              </p>
            )}
            <label className="start-field">
              Args (JSON)
              <textarea rows={6} spellCheck={false} value={form.argsText} onChange={(event) => onField("argsText", event.target.value)} />
              <span className="note">
                {chosen && chosen.optionalArgs.length > 0 ? (
                  <>
                    Also accepted: {chosen.optionalArgs.map((name, index) => (
                      <span key={name}>
                        {index > 0 && ", "}
                        <code>{name}</code>
                      </span>
                    ))}
                    .
                  </>
                ) : (
                  "Fill in the fields above; the server checks them against the workflow before it starts anything."
                )}
              </span>
            </label>
            <div className="start-grid">
              <label className="start-field">
                maxTokens
                <input type="number" inputMode="numeric" step="1" required placeholder="e.g. 200000" value={form.maxTokens} onChange={(event) => onField("maxTokens", event.target.value)} />
                <span className="note">The run stops when it has used this many tokens.</span>
              </label>
              <label className="start-field">
                maxCents
                <input type="number" inputMode="decimal" step="any" required placeholder="e.g. 50" value={form.maxCents} onChange={(event) => onField("maxCents", event.target.value)} />
                <span className="note">The run stops when it has cost this many cents. The global caps still apply on top.</span>
              </label>
            </div>
          </>
        )}
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        <div className="start-actions">
          <button type="submit" className="btn" disabled={sending || chosen === undefined}>
            {sending ? "Starting…" : "Start"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </section>
  );
}

export function StartPanel({ onClose }: { onClose(): void }) {
  const [repos, setRepos] = useState<Fetched<string[]>>({ state: "loading" });
  const [workflows, setWorkflows] = useState<Fetched<WorkflowsReply>>();
  const [form, setForm] = useState<StartFormState>(EMPTY_FORM);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const latestRepo = useRef("");

  /** Chooses `repo`: its workflows are fetched, and the first one fills the args box. An answer for a repository that is no longer the chosen one is dropped. */
  const chooseRepo = useCallback(async (repo: string) => {
    latestRepo.current = repo;
    setForm((before) => ({ ...before, repo, workflow: "", argsText: EMPTY_FORM.argsText }));
    setWorkflows({ state: "loading" });
    setError(undefined);
    const reply = await loadWorkflows(repo);
    if (latestRepo.current !== repo) return;
    if (!reply.ok) return setWorkflows({ state: "failed", error: reply.error });
    setWorkflows({ state: "ready", value: reply.body });
    const first = reply.body.workflows[0];
    setForm((before) => ({ ...before, workflow: first?.name ?? "", argsText: argsTextOf(first) }));
  }, []);

  useEffect(() => {
    document.getElementById("start-panel")?.focus(); // opening the panel moves the keyboard into it
    let stopped = false;
    void loadRepos().then((reply) => {
      if (stopped) return;
      if (!reply.ok) return setRepos({ state: "failed", error: reply.error });
      setRepos({ state: "ready", value: reply.body.repos });
      const first = reply.body.repos[0];
      if (first !== undefined) void chooseRepo(first);
    });
    return () => {
      stopped = true;
    };
  }, [chooseRepo]);

  const chooseWorkflow = (name: string) => {
    const entry = workflows?.state === "ready" ? workflows.value.workflows.find((workflow) => workflow.name === name) : undefined;
    setForm((before) => ({ ...before, workflow: name, argsText: argsTextOf(entry) }));
    setError(undefined);
  };

  const submit = async () => {
    const built = startBody(form);
    if (!built.ok) return setError(built.error);
    setSending(true);
    setError(undefined);
    const reply = await postStart(built.body);
    if (reply.ok) {
      window.location.assign(runHref(reply.body.runId)); // the run registers itself a moment from now: its page waits for it
      return;
    }
    setSending(false);
    setError(reply.error);
  };

  return (
    <StartPanelView
      repos={repos}
      workflows={workflows}
      form={form}
      sending={sending}
      error={error}
      onRepo={(repo) => void chooseRepo(repo)}
      onWorkflow={chooseWorkflow}
      onField={(field, value) => setForm((before) => ({ ...before, [field]: value }))}
      onSubmit={() => void submit()}
      onClose={onClose}
    />
  );
}
