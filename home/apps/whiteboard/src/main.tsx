import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../../_shared/app-identities.css";
import "./styles.css";

document.documentElement.dataset.app = "whiteboard";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
