import React from "react";
import { createRoot } from "react-dom/client";
import { AutomaticAiUsagePanel } from "../../packages/ui/src/ai-usage/AutomaticAiUsagePanel";
import {
  readUsageExport,
} from "../../packages/contracts/src/ai-usage/index";
import "../../packages/ui/src/ai-usage/ai-usage.css";
import "./preview.css";
const load = async (signal: AbortSignal) => {
  const response = await fetch("/api/ai-usage", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
  });
  if (!response.ok) throw new Error("Usage unavailable");
  return readUsageExport(await response.json());
};
function Preview() {
  return (
    <div className="usage-preview">
      <aside>
        <div className="preview-logo">
          ▧ <strong>matrix</strong>
        </div>
        <small>SETTINGS COMPONENT PREVIEW</small>
        <div className="preview-nav">Agents & providers</div>
        <div className="preview-nav selected">◈ &nbsp; AI usage</div>
        <div className="preview-nav">Import chats</div>
        <div className="preview-nav">Connect Apps</div>
        <div className="preview-nav">Appearance</div>
        <footer>
          ENG-440 · local POC
          <br />
          Matrix computer history
          <br />
          No production changes
        </footer>
      </aside>
      <main>
        <AutomaticAiUsagePanel load={load} sourceLabel="your Matrix computer" />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
