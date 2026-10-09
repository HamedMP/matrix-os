import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../../../_shared/game-refresh.css";
import "../../../_shared/matrix-brand.css";

document.documentElement.dataset.app = "tetris";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
