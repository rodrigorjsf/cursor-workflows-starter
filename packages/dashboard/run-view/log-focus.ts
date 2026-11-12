// Where the keyboard focus goes when a step's log opens and closes. Under 800px the log is drawn over the canvas: the node
// that had the focus, and every Tab stop of the canvas, sit under it (the stylesheet hides the canvas meanwhile). The focus
// moves into the log, and back to the node when the log closes. Beside the canvas, the focus stays where the reader put it.

/** The page, as far as these functions read it: what has the focus, the body, and a lookup of a node. */
export interface FocusDoc {
  readonly activeElement: unknown;
  readonly body: unknown;
  querySelector(selectors: string): { focus(): void } | null;
}

/** The element of the node `id` that takes the focus: the step or command drawn inside React Flow's wrapper. */
const nodeSelector = (id: string): string => `.react-flow__node[data-id="${id.replace(/["\\]/g, "\\$&")}"] .work`;

/** On open: into the log (its Close button) when the panel is positioned over the canvas, which then hides the focus. */
export function focusOnOpen(panel: Element, close: { focus(): void }, style: (el: Element) => { position: string }): void {
  if (style(panel).position !== "static") close.focus();
}

/**
 * On close: back to the node whose log it was, when the focus went away with the panel (it is then on the body). A focus
 * elsewhere, such as on another node the reader clicked to open its log, stays where it is.
 */
export function focusOnClose(doc: FocusDoc, nodeId: string): void {
  if (doc.activeElement !== null && doc.activeElement !== doc.body) return;
  doc.querySelector(nodeSelector(nodeId))?.focus();
}
