// The value of one row of a node's details: plain text, or a link when the row has an address. Used by the tooltip of a node and by
// the facts above a step's log.
import type { NodeRow } from "./node-details.js";

/**
 * `tabbable` false takes the link out of the tab order: the tooltip is shown while its node has the focus and goes when the focus
 * moves into it, so a link in it cannot be reached by keyboard. The same link in the step's log panel can.
 */
export function RowValue({ row, tabbable = true }: { row: NodeRow; tabbable?: boolean }) {
  if (row.href === undefined) return <>{row.value}</>;
  return (
    // `nopan`: pressing on the link must not start moving the canvas. A click on it must not open the node's log either.
    <a className="nopan" href={row.href} target="_blank" rel="noreferrer noopener" tabIndex={tabbable ? undefined : -1} onClick={(event) => event.stopPropagation()}>
      {row.value} <span aria-hidden="true">↗</span>
    </a>
  );
}
