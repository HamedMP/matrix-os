import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./design-refresh.css";
import "../../_shared/gallery-family.css";
import "../../_shared/app-identities.css";

document.documentElement.dataset.app = "notes";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
