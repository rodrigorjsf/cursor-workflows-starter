// The events of one run, in the browser: found through the API, then followed over Server-Sent Events.
//
// - The run is registered a moment after `start_workflow` returns its id, so the stream is opened only once the API knows
//   the run (a browser's EventSource does not retry after a 404).
// - While the run is running the stream stays open; otherwise it is read until it goes quiet and closed (the server never ends
//   a stream: a resumed run adds to the same log). The status is polled, so a resume of a finished run reopens the stream.
// - Events are handed over in batches, so a burst (the replay of a long log) is one render, not one per event.
import type { JobStart } from "./resume-command.js";
import { useEffect, useRef, useState } from "react";
import { batcher } from "./batch.js";
import { runApiPath } from "./location.js";
import type { RunEvent } from "./run-graph.js";

/** `waiting`: the API does not know the run yet. `closed`: the stream was read to the end and shut. */
export type Connection = "waiting" | "live" | "reconnecting" | "closed" | "not-found";

/** The status the API gives a run (`GET /api/runs/<runId>`): `missing` is a run the index knows and whose log cannot be read. */
export type ApiStatus = "running" | "finished" | "failed" | "cancelled" | "missing";

/** What the API says about the run itself: where it lives and which workflow it runs. */
export interface RunInfo {
  workflow: string;
  repo: string;
  /** How the latest execution's job was started, when the API knows (see `JobStart` in the runtime). */
  start?: JobStart;
}

export interface RunFeed {
  events: RunEvent[];
  /** The log line each event came from, one per event: how a replay lines the events up with a step's content. */
  ids: number[];
  /** Undefined until the API answers. */
  status?: ApiStatus;
  /** Why the run failed or was cancelled, as the API says (for a run whose process died: the runtime's error, with its resume hint). */
  error?: string;
  /** Why the latest look at the run's status failed (the dashboard is not answering). Cleared by the next one that works. */
  unreachable?: string;
  info?: RunInfo;
  connection: Connection;
  /** Asks the API for the run's status now, instead of at the next poll (after an action that changes it). */
  refresh(): void;
}

const BATCH_MS = 100;
const POLL_RUNNING_MS = 3000;
const POLL_SETTLED_MS = 10_000;
/** How long a run that the API does not know is waited for before it is reported as not found. */
const NOT_FOUND_AFTER_MS = 10_000;
/** How long a stream of a run that is not running may stay quiet before it is closed. */
const QUIET_MS = 1500;

export function useRunEvents(runId: string): RunFeed {
  const [feed, setFeed] = useState<{ events: RunEvent[]; ids: number[] }>({ events: [], ids: [] });
  const [status, setStatus] = useState<ApiStatus>();
  const [error, setError] = useState<string>();
  const [unreachable, setUnreachable] = useState<string>();
  const [info, setInfo] = useState<RunInfo>();
  const pollNow = useRef<() => void>(() => undefined);
  const [connection, setConnection] = useState<Connection>("waiting");
  const lastId = useRef(0);
  const running = status === "running";
  const readable = status !== undefined && status !== "missing";

  useEffect(() => {
    if (runId === "") {
      setConnection("not-found"); // an address that names no run
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const since = Date.now();
    let latest: ApiStatus | undefined;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const reply = await fetch(runApiPath(runId));
          if (stopped) return;
          setUnreachable(reply.ok || reply.status === 404 ? undefined : `the dashboard answered ${reply.status}`);
          if (reply.ok) {
            const detail = (await reply.json()) as { status: ApiStatus; error?: unknown; workflow?: string; repo?: string; start?: JobStart };
            latest = detail.status;
            setStatus(latest);
            setError(typeof detail.error === "string" ? detail.error : undefined);
            const { workflow, repo } = detail;
            const start = detail.start && typeof detail.start === "object" && "args" in detail.start ? detail.start : undefined;
            if (typeof workflow === "string" && typeof repo === "string")
              setInfo((before) => (before && before.workflow === workflow && before.repo === repo && JSON.stringify(before.start) === JSON.stringify(start) ? before : { workflow, repo, start }));
            if (latest === "missing") setConnection("not-found");
          } else if (reply.status === 404 && Date.now() - since > NOT_FOUND_AFTER_MS) setConnection("not-found");
        } catch (err) {
          // the dashboard is not answering: say so, and try again
          if (!stopped) setUnreachable(err instanceof Error ? err.message : String(err));
        }
      }
      if (!stopped) timer = setTimeout(poll, latest === "running" || latest === undefined ? POLL_RUNNING_MS : POLL_SETTLED_MS);
    };
    pollNow.current = () => {
      clearTimeout(timer);
      void poll();
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    if (!readable) return;
    const source = new EventSource(`${runApiPath(runId)}/events?content=false&lastEventId=${lastId.current}`);
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const batch = batcher<{ id: number; event: RunEvent }>(
      (arrived) => setFeed((before) => ({ events: before.events.concat(arrived.map((a) => a.event)), ids: before.ids.concat(arrived.map((a) => a.id)) })),
      BATCH_MS,
    );
    const goQuiet = () => {
      clearTimeout(quietTimer);
      if (running) return;
      quietTimer = setTimeout(() => {
        batch.flush();
        source.close();
        setConnection("closed");
      }, QUIET_MS);
    };
    source.onopen = () => {
      setConnection("live");
      goQuiet();
    };
    source.onmessage = (message: MessageEvent<string>) => {
      const id = Number(message.lastEventId);
      if (id <= lastId.current) return;
      lastId.current = id;
      try {
        batch.push({ id, event: JSON.parse(message.data) as RunEvent });
      } catch {
        return; // a line that is not JSON is not an event
      }
      goQuiet();
    };
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    return () => {
      clearTimeout(quietTimer);
      batch.flush();
      source.close();
    };
  }, [runId, readable, running]);

  return { events: feed.events, ids: feed.ids, status, error, unreachable, info, connection, refresh: () => pollNow.current() };
}
