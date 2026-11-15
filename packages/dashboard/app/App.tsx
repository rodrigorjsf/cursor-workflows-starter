// The app shell: the menus and the view each one opens. The menu is the URL's hash (`#/board`), so a menu can be linked and
// the back button works, with no router library.
import { useEffect, useRef, useState } from "react";
import { BoardView } from "./BoardView.js";
import { MetricsView } from "./MetricsView.js";
import { RunsView } from "./RunsView.js";
import { StartPanel } from "./StartPanel.js";
import type { StartPreset } from "./start-form.js";

const MENUS = [
  { id: "runs", label: "Runs" },
  { id: "board", label: "Board" },
  { id: "metrics", label: "Metrics" },
] as const;
type MenuId = (typeof MENUS)[number]["id"];

/** The menu a hash like `#/board` or `#/runs/<id>` names; the Board when it names none. */
function menuOf(hash: string): MenuId {
  const first = hash.replace(/^#\/?/, "").split("/")[0];
  return MENUS.find((menu) => menu.id === first)?.id ?? "board";
}

export function App() {
  const [menu, setMenu] = useState(() => menuOf(window.location.hash));
  // The Start panel is open when this is set; `preset` is what a Backlog card's run button asked it to open with, and `opened` makes a
  // second press of a run button a new panel (the form starts over) instead of the one that is already there.
  const [starting, setStarting] = useState<{ preset?: StartPreset; opened: number }>();
  const panelsOpened = useRef(0);
  const startButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const follow = () => setMenu(menuOf(window.location.hash));
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  useEffect(() => {
    document.title = `${MENUS.find((m) => m.id === menu)!.label} · Cursor Workflows`;
  }, [menu]);

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/board">
          <span className="logo" aria-hidden="true" />
          Cursor Workflows
        </a>
        <nav aria-label="Menu">
          {MENUS.map(({ id, label }) => (
            <a key={id} href={`#/${id}`} aria-current={id === menu ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <button ref={startButton} type="button" className="btn start-toggle" aria-expanded={starting !== undefined} aria-controls="start-panel" aria-label="Start a workflow" onClick={() => setStarting(starting ? undefined : { opened: ++panelsOpened.current })}>
          Start
        </button>
      </header>
      {starting && (
        <StartPanel
          key={starting.opened}
          preset={starting.preset}
          onClose={() => {
            setStarting(undefined);
            startButton.current?.focus(); // closing the panel gives the keyboard back to the button that opened it
          }}
        />
      )}
      <main className={`view view-${menu}`}>{menu === "runs" ? <RunsView /> : menu === "board" ? <BoardView onRun={(preset) => setStarting({ preset, opened: ++panelsOpened.current })} /> : <MetricsView />}</main>
    </>
  );
}
