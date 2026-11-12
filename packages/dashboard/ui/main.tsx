// The dashboard's browser entry: mounts the app. esbuild bundles this file, with React and the styles, when the dashboard starts.
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
