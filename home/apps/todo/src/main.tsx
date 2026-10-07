import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./design-refresh.css";
import "../../_shared/gallery-family.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
