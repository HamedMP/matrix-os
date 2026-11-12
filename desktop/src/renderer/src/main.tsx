import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { desktopQueryClient } from "./lib/query-client";
import "./design/index.css";
import { desktopFonts } from "@matrix-os/brand/tokens";
import { isTerminalWindowLocation } from "../../shared/terminal-window";

document.documentElement.style.setProperty("--font-ui", desktopFonts.sans);
document.documentElement.style.setProperty("--font-heading", desktopFonts.display);

// One trusted bundle serves both windows. Each loads only its own root, so the
// Terminal window never runs the main app's stores, analytics or embeds.
const loadRoot = isTerminalWindowLocation(window.location.search)
  ? import("./features/terminal-window/TerminalWindowApp")
  : import("./App");

void loadRoot.then(({ default: Root }) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={desktopQueryClient}>
        <Root />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}).catch((error: unknown) => {
  console.error("[renderer] failed to start:", error instanceof Error ? error.name : "UnknownError");
});
