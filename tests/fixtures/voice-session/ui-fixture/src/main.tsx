import { createRoot } from "react-dom/client";
import "../../../../../packages/ui/src/styles.css";
import "./fixture.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root was not found");

createRoot(root).render(<App />);
