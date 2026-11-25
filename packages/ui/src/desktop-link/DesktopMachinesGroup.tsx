import { useState, type CSSProperties } from "react";
import type { HerdrSession } from "@matrix-os/contracts/herdr-terminals";
import { Button } from "../Button.js";
import { terminalVisualStatus } from "../terminal-agents/attention.js";
import { TerminalStatusDot } from "../terminal-agents/TerminalStatusDot.js";
import { desktopTerminalRefKey, type DesktopAgent, type DesktopLinkMachine } from "./desktop-link-client.js";
import type { DesktopMachinesState } from "./use-desktop-machines.js";

const muted = "var(--terminal-drawer-muted, var(--matrix-muted-fg, #8a8a8a))";
const border = "var(--terminal-drawer-border, var(--matrix-border, rgba(127,127,127,0.25)))";
const selectedBackground = "var(--terminal-drawer-card-selected-bg, var(--bg-hover, rgba(127,127,127,0.18)))";
const selectedAccent = "var(--terminal-drawer-fg, var(--text-primary, currentColor))";

const AGENTS: Array<{ id: DesktopAgent; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
];

function lastSeen(machine: DesktopLinkMachine, now: number): string {
  if (!machine.lastSeenAt) return "Not connected yet";
  const minutes = Math.max(0, Math.round((now - Date.parse(machine.lastSeenAt)) / 60_000));
  if (minutes < 1) return "Last seen just now";
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Last seen ${hours} h ago` : `Last seen ${Math.round(hours / 24)} days ago`;
}

/**
 * "Desktops" (spec 2716): the owner's desktops linked to this computer, after the
 * project workspaces in every Terminal view. Shown only when at least one desktop
 * is enrolled; a desktop is linked from the desktop itself, never from here.
 */
export function DesktopMachinesGroup({ state, selectedRefKey, hideDeviceIds = [], now = Date.now(), onOpen, style }: {
  state: Pick<DesktopMachinesState, "desktops" | "terminals" | "busy" | "error" | "start" | "close" | "remove">;
  /** The `workspaceId:tabId` key of the terminal shown now, to mark its row. */
  selectedRefKey?: string | null;
  /** desktops not to list here, such as the desktop this view runs on. */
  hideDeviceIds?: readonly string[];
  now?: number;
  onOpen(deviceId: string, session: HerdrSession): void;
  style?: CSSProperties;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const hidden = new Set(hideDeviceIds);
  const busy = new Set(state.busy);
  const machines = state.desktops.machines.filter((machine) => !hidden.has(machine.deviceId));
  if (machines.length === 0) return null;
  // A terminal started here opens at once, as a new Matrix tab does.
  const open = (deviceId: string, agent: DesktopAgent | undefined, title: string) => {
    void state.start(deviceId, agent).then((started) => {
      if (started) onOpen(deviceId, { id: started.id, tabId: started.tabId, title, status: null });
    });
  };
  return (
    // The group sits on each surface's own drawer (dark on Web Terminal), so its buttons take
    // the surface's foreground instead of the page theme's.
    <section data-testid="desktop-machines" aria-label="Desktops"
      style={{ borderTop: `1px solid ${border}`, paddingTop: 8, ["--matrix-fg" as string]: "currentColor", ...style }}>
      <h3 style={{ color: muted, fontSize: 11, fontWeight: 600, letterSpacing: 0.4, margin: "0 0 4px", padding: "0 12px", textTransform: "uppercase" }}>
        Desktops
      </h3>
      {state.error ? <p role="alert" style={{ color: muted, fontSize: 12, margin: "0 12px 6px" }}>{state.error}</p> : null}
      {machines.map((machine) => {
        const online = machine.state === "online";
        const sessions = state.terminals[machine.deviceId]?.sessions ?? [];
        const starting = busy.has(`start:${machine.deviceId}`);
        const removing = busy.has(`remove:${machine.deviceId}`);
        const confirmKey = `remove:${machine.deviceId}`;
        return (
          <div key={machine.deviceId} data-desktop={machine.deviceId} data-state={machine.state} style={{ borderBottom: `1px solid ${border}`, paddingBottom: 6 }}>
            <div style={{ alignItems: "center", display: "flex", gap: 8, minHeight: 36, padding: "0 8px 0 12px" }}>
              <span aria-hidden="true" data-testid={`mac-state-${machine.deviceId.slice(0, 12)}`}
                style={{ background: online ? "var(--matrix-success, #22c55e)" : muted, borderRadius: 999, flexShrink: 0, height: 8, width: 8 }} />
              <span style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{machine.name}</span>
                <span style={{ color: muted, fontSize: 11 }}>{online ? "Online" : `Offline · ${lastSeen(machine, now)}`}</span>
              </span>
              {confirming === confirmKey ? null : (
                <Button variant="ghost" size="sm" aria-label={`Remove ${machine.name}`} disabled={removing} onClick={() => setConfirming(confirmKey)}>
                  Remove
                </Button>
              )}
            </div>
            {confirming === confirmKey ? (
              <div role="group" aria-label={`Confirm removing ${machine.name}`} style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, padding: "0 8px 8px 12px" }}>
                <span style={{ color: muted, flex: "1 1 100%", fontSize: 12 }}>
                  Remove this device? This computer loses access at once. Terminals keep running on the desktop, and it has to be switched on again there.
                </span>
                <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
                <Button variant="destructive" size="sm" disabled={removing}
                  onClick={() => { void state.remove(machine).then((done) => { if (done) setConfirming(null); }); }}>
                  {removing ? "Removing…" : "Remove desktop"}
                </Button>
              </div>
            ) : null}
            {online ? (
              <>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {sessions.map((session) => {
                    const key = desktopTerminalRefKey(machine.deviceId, session);
                    const selected = selectedRefKey === key;
                    const closeKey = `close:${machine.deviceId}:${session.id}`;
                    const closing = busy.has(closeKey);
                    return (
                      <li key={session.id} data-desktop-terminal={session.id} data-selected={selected ? "true" : "false"}
                        style={{ background: selected ? selectedBackground : "transparent", boxShadow: selected ? `inset 3px 0 0 ${selectedAccent}` : "none" }}>
                        <div style={{ alignItems: "center", display: "flex", gap: 8, minHeight: 34, padding: "0 8px 0 20px" }}>
                          <button type="button" aria-label={`Open ${session.title} on ${machine.name}`} aria-current={selected || undefined}
                            onClick={() => onOpen(machine.deviceId, session)}
                            style={{
                              alignItems: "center", background: "transparent", border: "none", color: "inherit", cursor: "pointer",
                              display: "flex", flex: 1, gap: 8, minWidth: 0, padding: "4px 0", textAlign: "left", fontWeight: selected ? 600 : 400,
                            }}>
                            <TerminalStatusDot status={terminalVisualStatus(session.status ?? undefined) ?? "idle"} testId={`mac-terminal-status-${session.id}`} />
                            <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</span>
                          </button>
                          {confirming === closeKey ? (
                            <>
                              <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
                              <Button variant="destructive" size="sm" disabled={closing} aria-label={`End ${session.title} on ${machine.name}`}
                                onClick={() => { void state.close(machine.deviceId, session.id).then((done) => { if (done) setConfirming(null); }); }}>
                                {closing ? "Ending…" : "End"}
                              </Button>
                            </>
                          ) : (
                            <Button variant="ghost" size="sm" aria-label={`Close ${session.title} on ${machine.name}`} onClick={() => setConfirming(closeKey)}>
                              Close
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div role="group" aria-label={`Start on ${machine.name}`} style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "4px 8px 0 20px" }}>
                  <Button variant="secondary" size="sm" disabled={starting} onClick={() => open(machine.deviceId, undefined, "Terminal")}>
                    {starting ? "Starting…" : "New terminal"}
                  </Button>
                  {AGENTS.map((agent) => (
                    <Button key={agent.id} variant="ghost" size="sm" disabled={starting} aria-label={`Start ${agent.label} on ${machine.name}`}
                      onClick={() => open(machine.deviceId, agent.id, agent.label)}>
                      {agent.label}
                    </Button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
