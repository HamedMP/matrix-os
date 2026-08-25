import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CompanionSurface } from "./features/companion/CompanionSurface";
import "./design/index.css";

const surface = new URLSearchParams(window.location.search).get("surface");
const companionHost = new URLSearchParams(window.location.search).get("host") === "notch"
  ? "notch"
  : "rabbit";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {surface === "companion" ? <CompanionSurface host={companionHost} /> : <App />}
  </React.StrictMode>,
);
