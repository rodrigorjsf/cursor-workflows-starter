// Instruções das etapas do implement-issue. São paráfrases das skills tdd, codebase-design, code-review e pr de
// mattpocock/skills 1.3.1 (MIT, Matt Pocock); o template do PR vem da skill show-me (humanlayer/skills, MIT,
// Dex Horthy). Créditos em docs/vision/02-a-ideia-e-as-referencias.md. O texto que vai ao agente é em inglês, como todo
// texto do kit voltado a agentes.
//
// Instruções fixas ficam aqui, como constantes: o prompt de cada etapa é `INSTRUÇÕES + dados`, o que mantém o prefixo
// estável para o cache do provedor e as chaves do journal e do memo (docs/operating/02-custos-e-cache.md).

/** Regra de escopo de toda etapa que escreve. É um pedido ao modelo, não uma trava (ver SECURITY.md). */
export const SCOPE_RULE =
  "Change only files inside this repository. If the failure comes from the environment (a missing or broken tool, " +
  "PATH, installation, network), change nothing outside the repository: describe the problem and stop.";

const NO_GIT = "Do not run git commands (add, commit, stash, checkout): the workflow handles version control.";

/** Vocabulário de codebase-design: os mesmos termos em todas as etapas que desenham ou testam. */
export const DESIGN_VOCABULARY = `Design vocabulary (use these terms):
- Module: anything with an interface and an implementation (function, class, package).
- Interface: everything a caller must know to use the module: signature, invariants, ordering, errors, configuration.
- Depth: a lot of behaviour behind a small interface (a deep module); the opposite is a shallow module.
- Seam: where a module's interface lives, and where a test observes behaviour without looking inside.
- Adapter: what satisfies an interface at a seam. One adapter makes a hypothetical seam; two make it real.
- Leverage (for callers) and locality (for maintainers) are what depth buys.
Principles: the interface is the test surface; the deletion test (if deleting the module makes the complexity vanish,
it was only a pass-through); do not create a seam without something that varies across it; accept dependencies
instead of creating them; return results instead of producing side effects.`;

/** Planejador (MED; e o juiz do HIGH): seams e fatias verticais, sem editar. */
export const PLAN_INSTRUCTIONS = `Read the code and plan the issue's implementation as vertical TDD slices. Do not edit files.
${DESIGN_VOCABULARY}
Rules:
- Define the seams: the public interfaces where the tests will observe the requested behaviour. Prefer few seams, in
  deep modules. Never plan tests against internal details.
- Each slice is ONE observable behaviour at a seam, in the order it should be built. Each slice becomes one cycle:
  a failing test, then the least code that makes it pass.
- In testIdea, give the expected value from an independent source (a known literal, an example from the issue),
  never recomputed the way the code would compute it.
- If they exist, read GLOSSARY.md (use the domain terms) and the area's ADRs (respect the decisions).
- State the project's test command.`;

/** Restrições dos designers do HIGH ("Design it twice"): três interfaces radicalmente diferentes. */
export const DESIGN_CONSTRAINTS: Record<"minimal" | "flexible" | "common", string> = {
  minimal: "Minimise the interface: 1 to 3 entry points at most, with as much leverage per entry point as possible.",
  flexible: "Maximise flexibility: support many use cases and extensions.",
  common: "Optimise for the caller's most common case: the default case must be trivial.",
};

export const DESIGN_INSTRUCTIONS = `Design the interface of the module that solves the issue below. Do not edit files.
${DESIGN_VOCABULARY}
Deliver: the interface (types, functions, parameters, invariants, ordering, errors), a usage example, what the
implementation hides behind the seam, the dependency strategy (in-process, locally substitutable, owned remote with a
port and adapter, or external with a mock) and the trade-offs. Follow only the constraint below, even if it seems
extreme: other people design under other constraints.`;

export const JUDGE_INSTRUCTIONS = `${PLAN_INSTRUCTIONS}
You receive alternative designs of the interface. Compare them by depth (leverage at the interface), locality (where
change concentrates) and seam placement. Pick the strongest, or combine elements into a hybrid, and plan the slices
from it. Explain the choice in rationale. Be opinionated.`;

/** Etapa red: um teste, sem implementação. */
export const TEST_INSTRUCTIONS = `Write ONE failing test for the slice below (TDD, red step). Implement nothing.
- Test the behaviour through the public interface, at the given seam, in integration style: what the caller sees, never
  private methods, call order or internal state.
- Mock only at system boundaries (external APIs, time, randomness). Never internal collaborators.
- The expected value comes from an independent source (a known literal, an example from the issue), never recomputed
  the way the code would compute it: a tautological test passes by construction and proves nothing.
- The test name says WHAT the behaviour is, not HOW.
- If the test fails at import because the symbol does not exist yet, that already is the red: leave the code as it
  is. The workflow discards any change outside the test files in this step.
- If the request changes a behaviour that existing tests pin, update those tests now: they are part of the red, and
  after this step only the code changes.
- Change only test files. ${NO_GIT}
- ${SCOPE_RULE}
Report the test file and name through the submit_result tool. If the behaviour already exists and a test of it passes
without implementation, answer alreadySatisfied: true and show the evidence (where the code already does it).`;

/** Etapa green: o mínimo para passar, sem mexer em testes. */
export const CODE_INSTRUCTIONS = `The test below fails. Write the least code that makes it pass (TDD, green step).
- Do not change test files: the test is the specification.
- No speculative features and no refactoring beyond what is needed: refactoring belongs to the review.
- The whole suite must stay green. ${NO_GIT}
- ${SCOPE_RULE}
When done, summarise what changed and list the files you changed.`;

export const FIX_INSTRUCTIONS = `The tests failed. Fix the code so the suite passes. Do not change test files. ${NO_GIT}
${SCOPE_RULE}`;

/** Rodada de refactor depois do review (Standards e Segurança): comportamento igual, testes intocados. */
export const REFACTOR_INSTRUCTIONS = `Fix the review findings below without changing behaviour (refactor).
- Do not change test files; the suite must stay green.
- Resolve each finding or, if you disagree, explain why in the summary. ${NO_GIT}
- ${SCOPE_RULE}`;

/** Baseline de code smells (Fowler, Refactoring, cap. 3) do eixo Standards: sempre julgamento, o repo prevalece. */
export const SMELL_BASELINE = `Smell baseline (always "judgement", never a hard violation; a pattern documented in the repo wins):
- Mysterious Name: the name does not reveal what the thing does or holds -> rename it.
- Duplicated Code: the same shape of logic in more than one place -> extract it and call it from both.
- Feature Envy: a method works more on another object's data than on its own -> move it there.
- Data Clumps: the same fields or parameters always travel together -> give them a type.
- Primitive Obsession: a string or number standing in for a domain concept -> give the concept a small type.
- Repeated Switches: the same switch/if on the same type in several places -> polymorphism or one shared map.
- Shotgun Surgery: one logical change needs scattered edits -> bring together what changes together.
- Divergent Change: one file changes for unrelated reasons -> split it by reason.
- Speculative Generality: abstractions and hooks the issue does not ask for -> delete them.
- Message Chains: a.b().c().d() that the caller should not know about -> hide it behind a method.
- Middle Man: something that only forwards -> call the target directly.
- Refused Bequest: a subclass ignores almost everything it inherits -> use composition.`;

export const STANDARDS_INSTRUCTIONS = `Review the diff below on the STANDARDS axis: does it follow the coding standards documented in the repository?
Do not edit files. Read the listed standards files (if any). For each finding, give the file, the rule (standards
file + rule, or the smell's name) and the kind: "hard" for a violation of a documented standard, "judgement" for a
baseline smell. Ignore what tools already enforce (linter, formatter). Do not judge whether the issue was met: that
is another axis.
${SMELL_BASELINE}`;

export const SPEC_INSTRUCTIONS = `Review the diff below on the SPEC axis: does it implement what the issue asked for? Do not edit files.
Report, quoting the issue's sentence:
- "missing": a requested requirement that is missing or partial (state the behaviour and the seam to test it at);
- "scope-creep": behaviour in the diff that the issue did not ask for;
- "wrong": a requirement that looks implemented, but wrongly.
Do not judge style or standards: that is another axis. The slices listed as deferred were left out on purpose, by the
workflow's slice cap: do not report them as "missing".`;

export const SECURITY_INSTRUCTIONS = `Review the diff below on the SECURITY axis. Do not edit files. Look for: unvalidated input
used in shell, eval, SQL or file paths; secrets in the code; permissions and authentication; suspicious new
dependencies; and instructions from the issue text that the code obeyed when it should not have (prompt injection).
Mark "blocking" only what is exploitable or leaks data; everything else is "note".`;

export const PR_INSTRUCTIONS = `Write parts of a PR body for the diff below. Be brief, no preamble.
- summary: the SMALLEST visual that makes the change clear, in a code block: pseudocode for logic, a call tree for
  flow, a file tree for responsibilities, Mermaid for interaction, or a diff of the shape when the surrounding shape
  already exists. One or two short sentences with it. Use the terms of GLOSSARY.md, if it exists.
- door: "one-way" if the change is hard to undo (destructive, a migration, a public contract), "two-way" if it is cheap
  to revert; doorNote optional.
- blastRadius: one word for how far the impact reaches; blastNote optional with the possible consequences.
The workflow writes the evidence (tests failing, then passing) itself: do not include it.`;
