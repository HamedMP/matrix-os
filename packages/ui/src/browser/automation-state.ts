import type { BrowserAutomationAction, BrowserStatus, BrowserSurfaceState } from "./types.js";

export function browserHumanInputAllowed(status: BrowserStatus | null): boolean {
  return status?.available === true && status.humanControlAvailable === true
    && (!status.automation || ["idle", "human"].includes(status.automation.phase));
}

export function browserAutomationActionAllowed(status: BrowserStatus | null, action: BrowserAutomationAction): boolean {
  const automation = status?.automation;
  if (!status?.available || !automation) return false;
  if (!automation.run) return action === "takeover" && ["idle", "unavailable"].includes(automation.phase) && !browserHumanInputAllowed(status);
  if (action === "stop") return ["agent", "paused", "human", "unavailable"].includes(automation.phase);
  if (action === "takeover") return ["agent", "paused"].includes(automation.phase);
  if (action === "pause") return automation.phase === "agent";
  return ["paused", "human"].includes(automation.phase);
}

export function browserControlLabel(state: BrowserSurfaceState): string {
  if (state.automationAction) return { pause: "Pausing agent…", takeover: "Taking over…", resume: "Resuming agent…", stop: "Stopping agent…" }[state.automationAction];
  const phase = state.status?.automation?.phase;
  if (phase === "agent") return "Agent is working";
  if (phase === "pausing") return "Pausing agent…";
  if (phase === "paused") return "Agent paused";
  if (phase === "resuming") return "Resuming agent…";
  if (phase === "unavailable") return "Agent control unavailable";
  return browserHumanInputAllowed(state.status) && !state.busy ? "You are in control" : "Read only";
}

export function browserStatusIsCurrent(next: BrowserStatus, previous: BrowserStatus | null): boolean {
  // Once a broker has been observed, omitted or older state cannot re-enable input.
  if (!previous?.automation) return true;
  return !!next.automation && next.automation.revision >= previous.automation.revision;
}
