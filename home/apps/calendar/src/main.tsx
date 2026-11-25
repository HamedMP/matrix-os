import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../../_shared/office-ui/office-ui.css";
import "./styles.css";
import "../../_shared/gallery-family.css";
import "../../_shared/app-identities.css";
import "../../_shared/matrix-brand.css";

document.documentElement.dataset.app = "calendar";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
