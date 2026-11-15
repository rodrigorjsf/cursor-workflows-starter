// The name of the `implement-issue` workflow, in a module of its own: its definition (`meta.name`) and the parts the dashboard
// reaches through `observe` (the Backlog, the seams decision) read it from here, so they cannot drift apart, and those parts load
// no engine by importing it.

/** The name of the `implement-issue` workflow. */
export const IMPLEMENT_ISSUE = "implement-issue";
