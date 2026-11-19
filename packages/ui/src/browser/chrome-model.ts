import type { BrowserChromeAction, BrowserChromeModel } from "@matrix-os/contracts";
import { browserAutomationActionAllowed, browserControlLabel, browserHumanInputAllowed } from "./automation-state.js";
import type { BrowserSurfaceKind, BrowserSurfaceState } from "./types.js";

export interface BrowserChromeContext {
  surface: BrowserSurfaceKind;
  active: boolean;
  settingsOpen: boolean;
  canOpenCloudDesktop: boolean;
}

/** One derivation for every host: inline toolbar, web window title bar, and Electron title bar. */
export function browserChromeModel(state: BrowserSurfaceState, context: BrowserChromeContext): BrowserChromeModel {
  const desktop = context.surface === "desktop";
  const available = state.status?.available === true;
  const connected = state.connection === "connected";
  const interactive = context.active && available && connected && browserHumanInputAllowed(state.status) && !state.busy;
  const automation = state.status?.automation;
  const automationReady = available && connected && !state.busy && context.active;
  const allowed = (action: "takeover" | "pause" | "resume" | "stop") => automationReady && browserAutomationActionAllowed(state.status, action);
  const actions: BrowserChromeModel["actions"] = [];
  const add = (id: BrowserChromeAction, enabled: boolean) => actions.push({ id, disabled: !enabled });
  if (automation && !automation.run && browserAutomationActionAllowed(state.status, "takeover")) add("takeover", automationReady);
  if (automation?.run) {
    if (["agent", "pausing"].includes(automation.phase)) add("pause", allowed("pause"));
    if (["agent", "paused", "pausing"].includes(automation.phase)) add("takeover", allowed("takeover"));
    if (["paused", "human", "resuming"].includes(automation.phase)) add("resume", allowed("resume"));
    add("stop", allowed("stop"));
  }
  if (desktop) {
    add("show-desktop", interactive);
    add("open-files", interactive);
    add("open-terminal", interactive);
    add("restore-chrome", interactive);
  } else if (context.canOpenCloudDesktop) {
    add("open-cloud-desktop", true);
  }
  if (!context.settingsOpen && (state.connection === "disconnected" || state.connection === "unavailable")) {
    add("reconnect", !state.busy && context.active);
  }
  add("settings", true);
  return {
    surface: context.surface,
    connection: state.connection,
    control: connected ? browserControlLabel(state) : null,
    busy: state.busy,
    settingsOpen: context.settingsOpen,
    actions,
  };
}
