import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "../../_shared/gallery-family.css";
import "../../_shared/app-identities.css";
import "../../_shared/matrix-brand.css";

document.documentElement.dataset.app = "resource-manager";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
