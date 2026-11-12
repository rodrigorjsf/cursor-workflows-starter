// The run Board: a kanban with one board per workflow and one card per run. A board's columns are its workflow's phases
// followed by the four ends a run can have (Awaiting approval, Done, Failed, Cancelled). A run's column follows from its
// state, so a card moves by itself as the run's log grows. What a card says comes from the workflow (`ctx.card`).
//
// Pure: it takes the runs the runtime read and the state of the pull requests the cards link to, and builds the answer.
import type { RunCard, RunSummary, RunViewStatus } from "@cursor-workflows/runtime/observe";

export type ColumnKind = "phase" | "awaiting-approval" | "done" | "failed" | "cancelled";

export interface BoardColumn {
  /** Stable id of the column: `phase:<title>` for a phase, the kind for an end, `running` for the one column of a workflow with no phases. */
  key: string;
  title: string;
  kind: ColumnKind;
}

/** How GitHub says a pull request stands. */
export type PrState = "open" | "merged" | "closed";

export interface BoardLink {
  label: string;
  url: string;
  /** For a link to a GitHub pull request, when its state is known. */
  state?: PrState;
}

export interface BoardCard {
  runId: string;
  repo: string;
  status: RunViewStatus;
  /** The `key` of the column the run is in. */
  column: string;
  startedAt: string;
  finishedAt?: string;
  phase?: string;
  error?: string;
  spentCents: number;
  chargedCents: number;
  /** What the workflow put on the card. Absent when it set none: the Board shows the run id. */
  card?: { title: string; subtitle?: string; links: BoardLink[]; badges: string[] };
}

export interface Board {
  workflow: string;
  columns: BoardColumn[];
  /** Newest run first. */
  cards: BoardCard[];
}

export interface BoardResponse {
  /** The workflow with the newest run first. */
  boards: Board[];
}

const END_COLUMNS: BoardColumn[] = [
  { key: "awaiting-approval", title: "Awaiting approval", kind: "awaiting-approval" },
  { key: "done", title: "Done", kind: "done" },
  { key: "failed", title: "Failed", kind: "failed" },
  { key: "cancelled", title: "Cancelled", kind: "cancelled" },
];

/** The one phase column of a workflow whose runs enter no phase. */
const RUNNING_COLUMN: BoardColumn = { key: "running", title: "Running", kind: "phase" };

const phaseColumn = (title: string): BoardColumn => ({ key: `phase:${title}`, title, kind: "phase" });

/** The column of a run. `phases` are the board's phase columns, in order; a run that has entered none, or one the board has no column for, waits in the first. */
function columnOf(run: RunSummary, phases: readonly BoardColumn[]): string {
  switch (run.status) {
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "finished":
      // `unknown`: the workflow returned a result that names no status. It returned, and nothing says it did not deliver.
      return run.outcome === "pending" ? "awaiting-approval" : run.outcome === "failed" ? "failed" : "done";
    default: {
      const entered = run.phase === undefined ? undefined : phases.find((c) => c.key === `phase:${run.phase}`);
      return (entered ?? phases[0]!).key;
    }
  }
}

function cardOf(card: RunCard, states: ReadonlyMap<string, PrState>): NonNullable<BoardCard["card"]> {
  return { ...card, links: card.links.map((link) => ({ ...link, state: states.get(link.url) })) };
}

/**
 * The boards of `runs`, which are newest first: one per workflow, the workflow of the newest run first. A run whose log
 * could not be read (`missing`) has no state to place and is left out; the Runs list shows it with the reason.
 */
export function buildBoards(runs: readonly RunSummary[], states: ReadonlyMap<string, PrState> = new Map()): Board[] {
  const byWorkflow = new Map<string, RunSummary[]>();
  for (const run of runs) {
    if (run.status !== "missing") byWorkflow.set(run.workflow, [...(byWorkflow.get(run.workflow) ?? []), run]);
  }
  return [...byWorkflow].map(([workflow, group]) => {
    // The newest run's phases set the order; phases only older runs entered follow.
    const titles = [...new Set(group.flatMap((run) => run.phases))];
    const phases = titles.length > 0 ? titles.map(phaseColumn) : [RUNNING_COLUMN];
    return {
      workflow,
      columns: [...phases, ...END_COLUMNS],
      cards: group.map((run) => ({
        runId: run.runId,
        repo: run.repo,
        status: run.status,
        column: columnOf(run, phases),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        phase: run.phase,
        error: run.error,
        spentCents: run.spentCents,
        chargedCents: run.chargedCents,
        card: run.card && cardOf(run.card, states),
      })),
    };
  });
}
