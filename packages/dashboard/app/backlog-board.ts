// Pure: how the Backlog (`/api/backlog`) meets the boards (`/api/board`) on the page, and what a card's run button asks for. No DOM,
// network or clock. The Backlog is the first column of the board of the workflow it starts (`implement-issue`); a workflow with no
// run yet has no board from the server, so the Backlog gets one of its own, a board with that column alone.
import type { BacklogCard } from "../src/backlog.js";
import type { Board } from "../src/board.js";
import type { StartPreset } from "./start-form.js";

/** `boards`, with an empty board of `workflow` added at the end when none of them is its own. */
export function withBacklogBoard(boards: readonly Board[], workflow: string): Board[] {
  return boards.some((board) => board.workflow === workflow) ? [...boards] : [...boards, { workflow, columns: [], cards: [] }];
}

/** What a card's run button opens the Start form with: its repository, the workflow the Backlog starts, and the issue as that workflow's args. */
export const backlogPreset = (workflow: string, card: BacklogCard): StartPreset => ({ repo: card.repo, workflow, argsText: JSON.stringify({ issue: card.issue }, null, 2) });
