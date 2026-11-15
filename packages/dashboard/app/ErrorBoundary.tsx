// The error boundary both pages mount their root in, and what a page shows when it fails. An error in a component's render (an event of a
// shape the page does not know, a field it assumed) unmounts the whole React tree and leaves a blank page, with the reason only in the
// console. Here a failure shows the error and a link that reloads the page; `showCrashIn` does the same in plain DOM for an error no
// boundary caught (React has already unmounted the tree then, so a component cannot show it). Its style, `crash.css`, is imported by the
// two entry files, which esbuild bundles: a test that renders this file has no loader for a style.
import { Component, type ReactNode } from "react";
import { CRASH_TITLE, RELOAD_LABEL, crashText } from "./crash.js";

/** The error and the way back. An empty `href` is the address of the page itself: following it reloads it. */
export function ErrorFallback({ error }: { error: unknown }) {
  return (
    <div className="crash" role="alert">
      <h1>{CRASH_TITLE}</h1>
      <pre>{crashText(error)}</pre>
      <a href="">{RELOAD_LABEL}</a>
    </div>
  );
}

interface BoundaryState {
  /** A boolean apart from `error`, because what was thrown may be `undefined`. */
  failed: boolean;
  error?: unknown;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown): void {
    console.error("dashboard: a component failed", error);
  }

  render(): ReactNode {
    return this.state.failed ? <ErrorFallback error={this.state.error} /> : this.props.children;
  }
}

/**
 * The `onUncaughtError` of a page's root: for an error that no boundary caught (one in the boundary itself), logs it and shows the
 * same error and link in plain DOM. React unmounts the tree as it reports the error, so it writes after that, not during.
 * Not yet run in a browser (see #101): whether the write survives React's unmount is a hypothesis.
 */
export function showCrashIn(container: HTMLElement): (error: unknown) => void {
  return (error) => {
    console.error("dashboard: an error nothing caught", error);
    setTimeout(() => {
      const doc = container.ownerDocument;
      const box = doc.createElement("div");
      box.className = "crash";
      box.setAttribute("role", "alert");
      const title = doc.createElement("h1");
      title.textContent = CRASH_TITLE;
      const message = doc.createElement("pre");
      message.textContent = crashText(error);
      const reload = doc.createElement("a");
      reload.setAttribute("href", "");
      reload.textContent = RELOAD_LABEL;
      box.append(title, message, reload);
      container.replaceChildren(box);
    }, 0);
  };
}
