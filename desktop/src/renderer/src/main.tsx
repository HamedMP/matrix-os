import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { desktopQueryClient } from "./lib/query-client";
import "./design/index.css";
import { desktopFonts } from "@matrix-os/brand/tokens";

document.documentElement.style.setProperty("--font-ui", desktopFonts.sans);
document.documentElement.style.setProperty("--font-heading", desktopFonts.display);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={desktopQueryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
