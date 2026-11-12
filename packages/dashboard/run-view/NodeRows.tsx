// The rows of a node's details as a definition list, for the tooltip of a node and for the facts above a step's log. A row with an
// address is a link.
import type { NodeRow } from "./node-details.js";

/**
 * `tabbable` false takes the links out of the tab order: the tooltip is shown while its node has the focus and goes when the focus
 * moves into it, so a link in it cannot be reached by keyboard. The same link in the step's log panel can.
 * A list with a link in it gets the class `linked`, which the tooltip's style uses to let the pointer reach the link.
 */
export function NodeRows({ rows, className, role, tabbable = true }: { rows: NodeRow[]; className: string; role?: "tooltip"; tabbable?: boolean }) {
  const linked = rows.some((row) => row.href !== undefined);
  return (
    <dl className={linked ? `${className} linked` : className} role={role}>
      {rows.map((row) => (
        <div key={row.name}>
          <dt>{row.name}</dt>
          <dd>
            {row.href === undefined ? (
              row.value
            ) : (
              // `nopan`: pressing on the link must not start moving the canvas. A click on it must not open the node's log either.
              <a className="nopan" href={row.href} target="_blank" rel="noreferrer noopener" tabIndex={tabbable ? undefined : -1} onClick={(event) => event.stopPropagation()}>
                {row.value} <span aria-hidden="true">↗</span>
              </a>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
