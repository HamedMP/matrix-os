"use client";

import type { BrowserChromeAction, BrowserChromeModel } from "@matrix-os/contracts";
import { FolderOpen, Globe2, Hand, Monitor, Pause, Play, RefreshCw, Settings2, Square, Terminal, type LucideIcon } from "lucide-react";
import "./browser-titlebar.css";

/** Host-owned presentation. Embeds send ids only; labels and icons never come from embed text. */
const ACTIONS: Record<BrowserChromeAction, { label: string; icon: LucideIcon; iconOnly?: boolean; tone?: "primary" }> = {
  "open-cloud-desktop": { label: "Cloud desktop", icon: Monitor },
  "open-browser": { label: "Browser", icon: Globe2 },
  "show-desktop": { label: "Show desktop", icon: Monitor, iconOnly: true },
  "open-files": { label: "Files", icon: FolderOpen, iconOnly: true },
  "open-terminal": { label: "Terminal", icon: Terminal, iconOnly: true },
  "restore-chrome": { label: "Open Chrome", icon: Globe2, iconOnly: true },
  takeover: { label: "Take over", icon: Hand },
  pause: { label: "Pause agent", icon: Pause },
  resume: { label: "Resume agent", icon: Play },
  stop: { label: "Stop agent", icon: Square },
  reconnect: { label: "Reconnect", icon: RefreshCw, tone: "primary" },
  settings: { label: "Browser settings", icon: Settings2, iconOnly: true },
};

const CONNECTION: Record<BrowserChromeModel["connection"], string> = {
  connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected", unavailable: "Unavailable", inactive: "Paused",
};

export function browserChromeActionLabel(model: BrowserChromeModel, action: BrowserChromeAction): string {
  // Before any automation run exists, taking over means claiming the read-only view.
  return action === "takeover" && !model.actions.some((entry) => ["pause", "resume", "stop"].includes(entry.id)) ? "Take control" : ACTIONS[action].label;
}

export function BrowserTitleBarControls({ model, onAction }: { model: BrowserChromeModel; onAction: (action: BrowserChromeAction) => void }) {
  // A pending agent transition ("Taking over…") is more specific than the generic busy text.
  const status = model.control?.endsWith("…") ? model.control
    : model.busy ? "Applying action…" : model.control ?? CONNECTION[model.connection];
  return (
    <div className="matrix-browser-titlebar" data-matrix-browser-chrome="" data-surface={model.surface}
      onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <span className="matrix-browser-titlebar-status" role="status" data-connection={model.connection} title={status}>
        <span className="matrix-browser-titlebar-dot" aria-hidden="true" />
        <span className="matrix-browser-titlebar-status-text">{status}</span>
      </span>
      {model.actions.map(({ id, disabled }) => {
        const { icon: Icon, iconOnly, tone } = ACTIONS[id];
        const label = browserChromeActionLabel(model, id);
        return (
          <button key={id} type="button" className="matrix-browser-titlebar-button" data-icon-only={iconOnly ? "" : undefined}
            data-tone={tone} disabled={disabled} aria-label={iconOnly ? label : undefined} title={label}
            aria-expanded={id === "settings" ? model.settingsOpen : undefined} onClick={() => onAction(id)}>
            <Icon size={15} aria-hidden="true" />
            {!iconOnly && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
