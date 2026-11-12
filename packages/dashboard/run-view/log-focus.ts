// Where the keyboard focus goes when a step's log opens and closes. (Red stub: the focus does not move yet.)

/** The page, as far as these functions read it: what has the focus, the body, and a lookup of a node. */
export interface FocusDoc {
  readonly activeElement: unknown;
  readonly body: unknown;
  querySelector(selectors: string): { focus(): void } | null;
}

export function focusOnOpen(_panel: Element, _close: { focus(): void }, _style: (el: Element) => { position: string }): void {}

export function focusOnClose(_doc: FocusDoc, _nodeId: string): void {}
