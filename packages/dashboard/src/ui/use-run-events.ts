// The events of one run, in the browser: found through the API, then followed over Server-Sent Events.
//
// - The run is registered a moment after `start_workflow` returns its id, so the stream is opened only once the API knows
//   the run (a browser's EventSource does not retry after a 404).
// - While the run is running the stream stays open; otherwise it is read until it goes quiet and closed (the server never ends
//   a stream: a resumed run adds to the same log). The status is polled, so a resume of a finished run reopens the stream.
// - Events are handed over in batches, so a burst (the replay of a long log) is one render, not one per event.
import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "./run-graph.js";

/** `waiting`: the API does not know the run yet. `closed`: the stream was read to the end and shut. */
export type Connection = "waiting" | "live" | "reconnecting" | "closed" | "not-found";

/** The status the API gives a run (`GET /api/runs/<runId>`): `missing` is a run the index knows and whose log cannot be read. */
export type ApiStatus = "running" | "finished" | "failed" | "cancelled" | "missing";

/** What the API says about the run itself: where it lives and which workflow it runs. */
export interface RunInfo {
  workflow: string;
  repo: string;
}

export interface RunFeed {
  events: RunEvent[];
  /** The log line each event came from, one per event: how a replay lines the events up with a step's content. */
  ids: number[];
  /** Undefined until the API answers. */
  status?: ApiStatus;
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
          const reply = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
          if (stopped) return;
          if (reply.ok) {
            const detail = (await reply.json()) as { status: ApiStatus; workflow?: string; repo?: string };
            latest = detail.status;
            setStatus(latest);
            const { workflow, repo } = detail;
            if (typeof workflow === "string" && typeof repo === "string") setInfo((before) => (before && before.workflow === workflow && before.repo === repo ? before : { workflow, repo }));
            if (latest === "missing") setConnection("not-found");
          } else if (reply.status === 404 && Date.now() - since > NOT_FOUND_AFTER_MS) setConnection("not-found");
        } catch {
          /* the dashboard is not answering: try again */
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
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?content=false&lastEventId=${lastId.current}`);
    let batch: Array<{ id: number; event: RunEvent }> = [];
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(batchTimer);
      batchTimer = undefined;
      if (batch.length === 0) return;
      const arrived = batch;
      batch = [];
      setFeed((before) => ({ events: before.events.concat(arrived.map((a) => a.event)), ids: before.ids.concat(arrived.map((a) => a.id)) }));
    };
    const goQuiet = () => {
      clearTimeout(quietTimer);
      if (running) return;
      quietTimer = setTimeout(() => {
        flush();
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
      batchTimer ??= setTimeout(flush, BATCH_MS);
      goQuiet();
    };
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    return () => {
      clearTimeout(quietTimer);
      flush();
      source.close();
    };
  }, [runId, readable, running]);

  return { events: feed.events, ids: feed.ids, status, info, connection, refresh: () => pollNow.current() };
}
