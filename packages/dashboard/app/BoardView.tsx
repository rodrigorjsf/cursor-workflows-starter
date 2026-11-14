// The Board: one kanban per workflow, a column per phase plus Awaiting approval, Done, Failed and Cancelled, a card per run.
// The server decides which column a run is in; the Board polls, so a card moves a moment after its run does. An empty column
// folds into a narrow strip, so the columns that hold runs (Failed among them) stay in view on a wide screen.
//
// The board of the workflow the Backlog starts (`implement-issue`) has one more column in front: the Backlog, the open issues that
// carry the backlog label and have no run, each with a run button that opens the Start form for it. The Backlog is its own poll
// (`/api/backlog`: it waits for the forge, which the Board does not), so a forge that is slow or down never holds the runs back.
import type { ReactNode } from "react";
import type { BacklogCard, BacklogReply } from "../src/backlog.js";
import type { Board, BoardCard, BoardColumn, BoardLink, BoardResponse } from "../src/board.js";
import { backlogPreset, withBacklogBoard } from "./backlog-board.js";
import { formatCents, formatCount, repoName, runDuration, runHref } from "./format.js";
import { Empty, Loaded, PageHeader } from "./Loaded.js";
import type { StartPreset } from "./start-form.js";
import { type Polled, usePoll } from "./usePoll.js";

const POLL_MS = 2000;
/** The forge's answer is kept for a minute by the server: asking again every few seconds costs a look at the runs, not a forge call. */
const BACKLOG_POLL_MS = 5000;

const BACKLOG_COLUMN: BoardColumn = { key: "backlog", title: "Backlog", kind: "backlog" };

export function BoardView({ onRun }: { onRun(preset: StartPreset): void }) {
  const poll = usePoll<BoardResponse>("/api/board", POLL_MS);
  const backlog = usePoll<BacklogReply>("/api/backlog", BACKLOG_POLL_MS);
  return (
    <>
      <PageHeader title="Board" summary={poll.data ? boardSummary(poll.data) : undefined} />
      <Loaded poll={poll} what="the board">
        {(data) => <Boards data={data} backlog={backlog} onRun={onRun} />}
      </Loaded>
    </>
  );
}

/** The boards, and the Backlog in front of the one it starts. The Backlog shows only when it has an issue or an error to show. */
export function Boards({ data, backlog, onRun }: { data: BoardResponse; backlog: Polled<BacklogReply>; onRun(preset: StartPreset): void }) {
  const shown = backlog.data && (backlog.data.cards.length > 0 || backlog.data.errors.length > 0) ? backlog.data : undefined;
  const boards = shown ? withBacklogBoard(data.boards, shown.workflow) : data.boards;
  return (
    <>
      {backlog.data === undefined && backlog.error === undefined && (
        <p className="loading" role="status">
          Loading the Backlog…
        </p>
      )}
      {backlog.error !== undefined && (
        <p className="banner error" role="alert">
          Could not load the Backlog: {backlog.error}
          {backlog.data ? ". Showing the last answer." : ""}
        </p>
      )}
      {boards.length === 0 ? (
        <Empty title="No runs yet">
          Start a workflow from the chat or with <code>npm run wf -- start &lt;workflow&gt;</code>, and its card appears here.
        </Empty>
      ) : (
        boards.map((board) => <WorkflowBoard key={board.workflow} board={board} backlog={board.workflow === shown?.workflow ? shown : undefined} onRun={onRun} />)
      )}
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

export function WorkflowBoard({ board, backlog, onRun }: { board: Board; backlog?: BacklogReply; onRun(preset: StartPreset): void }) {
  return (
    <section className="board" aria-label={`${board.workflow} board`}>
      <h2>
        {board.workflow} <span className="count">{formatCount(board.cards.length)}</span>
      </h2>
      <div className="columns">
        {backlog && <BacklogColumn backlog={backlog} onRun={onRun} />}
        {board.columns.map((column) => {
          const cards = board.cards.filter((card) => card.column === column.key);
          return (
            <ColumnFrame key={column.key} column={column} count={cards.length} folded={cards.length === 0}>
              {cards.length > 0 && (
                <ul>
                  {cards.map((card) => (
                    <CardView key={card.runId} card={card} />
                  ))}
                </ul>
              )}
            </ColumnFrame>
          );
        })}
      </div>
    </section>
  );
}

/** A column: its title with the number of cards in it, and what it holds. A `folded` one is a strip: it holds nothing to read. */
function ColumnFrame({ column, count, folded, children }: { column: BoardColumn; count: number; folded: boolean; children: ReactNode }) {
  return (
    <div className={`column column-${column.kind}${folded ? " empty" : ""}`} role="group" aria-label={`${column.title}: ${count}`}>
      <h3>
        <span className="column-title">{column.title}</span> <span className="count">{formatCount(count)}</span>
      </h3>
      {children}
    </div>
  );
}

/** The Backlog column: a card for each issue ready and not started, and the repositories whose forge could not say. */
function BacklogColumn({ backlog, onRun }: { backlog: BacklogReply; onRun(preset: StartPreset): void }) {
  return (
    <ColumnFrame column={BACKLOG_COLUMN} count={backlog.cards.length} folded={backlog.cards.length === 0 && backlog.errors.length === 0}>
      {backlog.errors.map(({ repo, error }) => (
        <p key={repo} className="banner error" role="alert">
          {repoName(repo)}: {error}
        </p>
      ))}
      {backlog.cards.length > 0 && (
        <ul>
          {backlog.cards.map((card) => (
            <BacklogCardView key={`${card.repo}#${card.issue}`} card={card} workflow={backlog.workflow} onRun={onRun} />
          ))}
        </ul>
      )}
    </ColumnFrame>
  );
}

function BacklogCardView({ card, workflow, onRun }: { card: BacklogCard; workflow: string; onRun(preset: StartPreset): void }) {
  const title = `#${card.issue} ${card.title}`;
  return (
    <li className="card">
      {card.url ? (
        <a className="card-title" href={card.url} target="_blank" rel="noreferrer noopener">
          {title}
        </a>
      ) : (
        <span className="card-title">{title}</span>
      )}
      <div className="card-foot">
        <span className="repo" title={card.repo}>
          {repoName(card.repo)}
        </span>
        <button type="button" className="btn" aria-label={`Run ${workflow} for issue ${card.issue}`} onClick={() => onRun(backlogPreset(workflow, card))}>
          run
        </button>
      </div>
    </li>
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
