// A unified diff of one file, in the shape `git diff` prints, so `wf init` can show what it changed without running git.

type Op = { kind: " " | "-" | "+"; text: string };

/** The lines of a text, without the one a final newline ends. */
const linesOf = (text: string | undefined): string[] => (text === undefined || text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** The line-by-line edit script from `a` to `b`. The lines both share at the start and the end are skipped before the LCS table is built. */
function editScript(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const from = a.slice(head, a.length - tail);
  const to = b.slice(head, b.length - tail);

  // lcs[i][j]: length of the longest common subsequence of from[i..] and to[j..].
  const lcs = Array.from({ length: from.length + 1 }, () => new Array<number>(to.length + 1).fill(0));
  for (let i = from.length - 1; i >= 0; i--) {
    for (let j = to.length - 1; j >= 0; j--) lcs[i]![j] = from[i] === to[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }

  const ops: Op[] = a.slice(0, head).map((text) => ({ kind: " ", text }));
  let i = 0;
  let j = 0;
  while (i < from.length || j < to.length) {
    if (i < from.length && j < to.length && from[i] === to[j]) {
      ops.push({ kind: " ", text: from[i]! });
      i++;
      j++;
    } else if (i < from.length && (j === to.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ kind: "-", text: from[i++]! });
    else ops.push({ kind: "+", text: to[j++]! });
  }
  return ops.concat(a.slice(a.length - tail).map((text) => ({ kind: " ", text })));
}

/**
 * The diff of `path` from `before` to `after`, with 3 lines of context. A file that did not exist (`before` undefined)
 * shows as `/dev/null` on the old side, a deleted one (`after` undefined) on the new side. Empty when nothing differs.
 */
export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
  const ops = editScript(linesOf(before), linesOf(after));
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";

  // Changes closer than two contexts apart share a hunk.
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const last = hunks.at(-1);
    if (last && index - last[1] <= 2 * context) last[1] = index;
    else hunks.push([index, index]);
  }

  const out = [`--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`];
  for (const [first, last] of hunks) {
    const slice = ops.slice(Math.max(0, first - context), Math.min(ops.length, last + context + 1));
    const preceding = ops.slice(0, Math.max(0, first - context));
    const [oldCount, newCount] = [slice.filter((o) => o.kind !== "+").length, slice.filter((o) => o.kind !== "-").length];
    // An empty side starts at the line before, as git prints it.
    const oldStart = preceding.filter((o) => o.kind !== "+").length + (oldCount > 0 ? 1 : 0);
    const newStart = preceding.filter((o) => o.kind !== "-").length + (newCount > 0 ? 1 : 0);
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...slice.map((o) => o.kind + o.text));
  }
  return `${out.join("\n")}\n`;
}
