// The content of one step, in the browser: read through the API, then followed over Server-Sent Events while the step runs.
//
// - `GET /api/runs/<runId>/steps/<stepId>/content` is everything the log holds of the step so far, with the line it was read up
//   to; the stream (`events?stepId=<stepId>&lastEventId=<that line>`) continues from there with no gap and no repeat.
// - The stream is open only while the step is running. When the step ends the content is read once more (the last lines may
//   still be on their way) and the stream is closed. A resume that runs the step again flips it back, and it is followed again.
// - Items are kept by their line, so an item that comes twice (the read and the stream overlapping) is one.
// - Events are handed over in batches: a command that prints a thousand lines is a few renders, not a thousand.
import { useEffect, useRef, useState } from "react";
import { batcher } from "./batch.js";
import type { ContentItem } from "./step-log.js";

/** `loading`: nothing read yet. `ready`: read (the step may have no content yet). `error`: the dashboard could not give it. */
export type StepLogStatus = "loading" | "ready" | "error";

export interface StepLogFeed {
  items: ContentItem[];
  status: StepLogStatus;
  error?: string;
}

const BATCH_MS = 100;

export function useStepLog(runId: string, stepId: string, live: boolean): StepLogFeed {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [status, setStatus] = useState<StepLogStatus>("loading");
  const [error, setError] = useState<string>();
  const known = useRef(new Map<number, ContentItem>());
  const lastLine = useRef(0);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;

    const add = (arrived: ContentItem[]) => {
      let changed = false;
      for (const item of arrived) {
        if (known.current.has(item.id)) continue;
        known.current.set(item.id, item);
        changed = true;
      }
      if (changed) setItems([...known.current.values()].sort((a, b) => a.id - b.id));
    };
    const batch = batcher<ContentItem>(add, BATCH_MS);

    const base = `/api/runs/${encodeURIComponent(runId)}`;
    void (async () => {
      try {
        const reply = await fetch(`${base}/steps/${encodeURIComponent(stepId)}/content`);
        if (stopped) return;
        if (reply.ok) {
          const body = (await reply.json()) as { lastEventId: number; content: ContentItem[] };
          if (stopped) return;
          add(body.content);
          lastLine.current = Math.max(lastLine.current, body.lastEventId);
        } else if (reply.status !== 404) {
          throw new Error(`the dashboard answered ${reply.status}`); // 404: the step has no event in the log yet
        }
        setError(undefined);
        setStatus("ready");
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
        return;
      }
      if (!live) return;
      source = new EventSource(`${base}/events?stepId=${encodeURIComponent(stepId)}&lastEventId=${lastLine.current}`);
      source.onmessage = (message: MessageEvent<string>) => {
        const id = Number(message.lastEventId);
        if (id <= lastLine.current) return;
        lastLine.current = id;
        try {
          const event = JSON.parse(message.data) as { type?: string } & Partial<ContentItem>;
          if (event.type === "content") batch.push({ ...event, id } as ContentItem);
        } catch {
          /* a line that is not JSON is not an event */
        }
      };
    })();

    return () => {
      stopped = true;
      source?.close();
      batch.flush();
    };
  }, [runId, stepId, live]);

  return { items, status, error };
}
