// The plan `implement-issue` makes for a MED or HIGH issue, and the one rule that says which test command a run executes for it. The
// workflow (`implement-issue.ts`) stores the plan when it stops to ask a person about the seams, and the seams approval of the
// dashboard (`seams-approval.ts`) reads it back to show what an approval lets the run do: both take the command from `testCommandOf`,
// so what a person is shown is what runs. No engine, no I/O.
import { z } from "zod";

export interface Slice {
  behavior: string;
  seam: string;
  testIdea: string;
}

export interface Plan {
  seams: Array<{ name: string; interface: string; why: string }>;
  slices: Slice[];
  testCommand: string;
  rationale?: string;
}

/** The plan as the progress file holds it (`proposedPlan` is an `unknown` there: this is where it takes its shape, or is refused). */
export const PLAN: z.ZodType<Plan> = z.looseObject({
  seams: z.array(z.looseObject({ name: z.string(), interface: z.string(), why: z.string() })),
  slices: z.array(z.looseObject({ behavior: z.string(), seam: z.string(), testIdea: z.string() })),
  testCommand: z.string(),
  rationale: z.string().optional(),
});

/** The test command of a LOW run, and of any run whose planner proposed none: a constant of the kit, not model text. */
export const DEFAULT_TEST_COMMAND = "npm test";

/** The test command the planner proposed; a blank one is no proposal (the run then takes the kit's `npm test`). */
export const proposedCommand = (plan: Plan): string | undefined => (plan.testCommand?.trim() ? plan.testCommand : undefined);

/** The test command a run executes for `plan`: the one a person typed (`testCommand` arg) as written, else the planner's, else the kit's `npm test`. */
export const testCommandOf = (plan: Plan, typed?: string): string => typed ?? proposedCommand(plan) ?? DEFAULT_TEST_COMMAND;
