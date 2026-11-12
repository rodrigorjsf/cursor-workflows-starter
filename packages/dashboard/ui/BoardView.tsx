// The Board: one kanban per workflow, a column per phase plus Awaiting approval, Done, Failed and Cancelled, a card per run.
// The server decides which column a run is in; the Board polls, so a card moves a moment after its run does.
import type { Board, BoardCard, BoardLink, BoardResponse } from "../src/board.js";
import { money, repoName, runDuration } from "./format.js";
import { Loaded } from "./Loaded.js";
import { usePoll } from "./usePoll.js";

const POLL_MS = 2000;

export function BoardView() {
  const poll = usePoll<BoardResponse>("/api/board", POLL_MS);
  return (
    <Loaded poll={poll} what="the board">
      {(data) => (
        <>
          {data.boards.length === 0 && (
            <p className="note">
              No runs yet. Start a workflow from the chat or with <code>npm run wf -- run</code>, and its card appears here.
            </p>
          )}
          {data.boards.map((board) => (
            <WorkflowBoard key={board.workflow} board={board} />
          ))}
        </>
      )}
    </Loaded>
  );
}

function WorkflowBoard({ board }: { board: Board }) {
  return (
    <section className="board" aria-label={`${board.workflow} board`}>
      <h2>
        {board.workflow} <span className="count">{board.cards.length}</span>
      </h2>
      <div className="columns">
        {board.columns.map((column) => {
          const cards = board.cards.filter((card) => card.column === column.key);
          return (
            <div key={column.key} className={`column column-${column.kind}`} role="group" aria-label={column.title}>
              <h3>
                {column.title} <span className="count">{cards.length}</span>
              </h3>
              <ul>
                {cards.map((card) => (
                  <CardView key={card.runId} card={card} />
                ))}
              </ul>
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
      <div className="card-title">{shown?.title ?? card.runId}</div>
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
      {card.error && <div className="card-error">{card.error}</div>}
      <div className="card-foot">
        <span title={card.repo}>{repoName(card.repo)}</span>
        <span>{money(card.spentCents)}</span>
        <span>{runDuration(card.startedAt, card.finishedAt)}</span>
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
      {link.state && <span className={`pr pr-${link.state}`}>{link.state}</span>}
    </div>
  );
}
