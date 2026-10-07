import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../../../../../shell/src/app/fonts.css";
import "./fixture.css";

document.body.classList.add("matrix-shell-fonts");

createRoot(document.getElementById("root")!).render(<App />);
