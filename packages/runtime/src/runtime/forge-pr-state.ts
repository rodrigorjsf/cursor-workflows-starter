// How a forge says a PR or MR stands, in the one vocabulary the kit uses (`OPEN`, `MERGED`, `CLOSED`). A leaf with no imports, so the
// forge seam of `implement-issue` (`workflows/implement-issue/forge.ts`) and the by-URL reader that `observe` offers the dashboard
// (`pr-by-url.ts`) read GitLab's states through the same table without either depending on the other (ADR-0009).

/** The state of a PR, as the forge reports it. */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** What GitLab's REST API calls a merge request that is still being worked on or is being merged: both are a live PR. */
const MR_STATES: Readonly<Record<string, PrState>> = { opened: "OPEN", locked: "OPEN", merged: "MERGED", closed: "CLOSED" };

/** The `PrState` of the `state` GitLab's REST API reports for a merge request, or undefined for one this version does not know. */
export const prStateOfMr = (state: string): PrState | undefined => (Object.hasOwn(MR_STATES, state) ? MR_STATES[state] : undefined);
