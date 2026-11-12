// The Board: one kanban per workflow, a column per phase plus Awaiting approval, Done, Failed and Cancelled, a card per run.
// The server decides which column a run is in; the Board polls, so a card moves a moment after its run does. An empty column
// folds into a narrow strip, so the columns that hold runs (Failed among them) stay in view on a wide screen.
import type { Board, BoardCard, BoardLink, BoardResponse } from "../src/board.js";
import { formatCents, formatCount, repoName, runDuration, runHref } from "./format.js";
import { Empty, Loaded, PageHeader } from "./Loaded.js";
import { usePoll } from "./usePoll.js";

const POLL_MS = 2000;

export function BoardView() {
  const poll = usePoll<BoardResponse>("/api/board", POLL_MS);
  return (
    <>
      <PageHeader title="Board" summary={poll.data ? boardSummary(poll.data) : undefined} />
      <Loaded poll={poll} what="the board">
        {(data) =>
          data.boards.length === 0 ? (
            <Empty title="No runs yet">
              Start a workflow from the chat or with <code>npm run wf -- start &lt;workflow&gt;</code>, and its card appears here.
            </Empty>
          ) : (
            data.boards.map((board) => <WorkflowBoard key={board.workflow} board={board} />)
          )
        }
      </Loaded>
    </>
  );
}

/** `5 runs in 2 workflows · 1 running`. */
function boardSummary(data: BoardResponse): string {
  const cards = data.boards.flatMap((b) => b.cards);
  const running = cards.filter((c) => c.status === "running").length;
  const parts = [`${formatCount(cards.length)} ${cards.length === 1 ? "run" : "runs"} in ${formatCount(data.boards.length)} ${data.boards.length === 1 ? "workflow" : "workflows"}`];
  if (running > 0) parts.push(`${formatCount(running)} running`);
  return parts.join(" · ");
}

export function WorkflowBoard({ board }: { board: Board }) {
  return (
    <section className="board" aria-label={`${board.workflow} board`}>
      <h2>
        {board.workflow} <span className="count">{formatCount(board.cards.length)}</span>
      </h2>
      <div className="columns">
        {board.columns.map((column) => {
          const cards = board.cards.filter((card) => card.column === column.key);
          return (
            <div key={column.key} className={`column column-${column.kind}${cards.length === 0 ? " empty" : ""}`} role="group" aria-label={`${column.title}: ${cards.length}`}>
              <h3>
                <span className="column-title">{column.title}</span> <span className="count">{formatCount(cards.length)}</span>
              </h3>
              {cards.length > 0 && (
                <ul>
                  {cards.map((card) => (
                    <CardView key={card.runId} card={card} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CardView({ card }: { card: BoardCard }) {
  const shown = card.card;
  return (
    <li className={`card status-${card.status}`}>
      <a className="card-title" href={runHref(card.runId)} title="Open the run">
        {shown?.title ?? card.runId}
      </a>
      {shown?.subtitle && <div className="card-sub">{shown.subtitle}</div>}
      {shown && shown.badges.length > 0 && (
        <div className="chips">
          {shown.badges.map((badge) => (
            <span key={badge} className="chip">
              {badge}
            </span>
          ))}
        </div>
      )}
      {shown?.links.map((link) => (
        <CardLink key={link.url} link={link} />
      ))}
      {card.error && (
        <div className={`card-error${card.status === "cancelled" ? " muted" : ""}`} title={card.error}>
          {card.error}
        </div>
      )}
      <div className="card-foot">
        <span className="repo" title={card.repo}>
          {repoName(card.repo)}
        </span>
        <span>{formatCents(card.spentCents)}</span>
        {/* a run whose process died recorded no end: its time is not known, and must not grow with the clock */}
        <span>{card.finishedAt !== undefined || card.status === "running" ? runDuration(card.startedAt, card.finishedAt) : "—"}</span>
      </div>
    </li>
  );
}

function CardLink({ link }: { link: BoardLink }) {
  return (
    <div className="card-link">
      <a href={link.url} target="_blank" rel="noreferrer noopener">
        {link.label}
      </a>
      {link.state && <span className={`pill pr-${link.state}`}>{link.state}</span>}
    </div>
  );
}
