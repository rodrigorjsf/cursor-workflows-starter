// The entry of the app page (`/`: the Runs, Board and Metrics menus): mounts the app. esbuild bundles this file, with React and the styles, when the dashboard starts.
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./tokens.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
