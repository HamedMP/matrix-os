import { useState, type CSSProperties } from "react";
import { Button } from "../Button.js";
import { terminalVisualStatus } from "../terminal-agents/attention.js";
import { TerminalStatusDot } from "../terminal-agents/TerminalStatusDot.js";
import { herdrSessionRefKey, shouldShowHerdrSessions, type HerdrSession, type HerdrSessionList } from "./herdr-sessions-client.js";

const muted = "var(--terminal-drawer-muted, var(--matrix-muted-fg, #8a8a8a))";
const border = "var(--terminal-drawer-border, var(--matrix-border, rgba(127,127,127,0.25)))";

/**
 * "Herdr sessions" (spec 2701): the owner's existing Herdr terminals, shown
 * after the project workspaces in every Terminal view. Rendered only for a
 * reachable core with at least one terminal; there is no create action, since
 * new terminals are Matrix terminals.
 */
export function HerdrSessionsGroup({ list, selectedRefKey, closingIds = [], error, onOpen, onClose, style }: {
  list: HerdrSessionList | null;
  /** The `workspaceId:tabId` key of the terminal shown now, to mark its row. */
  selectedRefKey?: string | null;
  closingIds?: readonly string[];
  error?: string | null;
  onOpen(session: HerdrSession): void;
  /** Resolves true once the terminal ended; the row stays until then. */
  onClose(session: HerdrSession): Promise<boolean>;
  style?: CSSProperties;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  if (!shouldShowHerdrSessions(list) || !list) return null;
  const closingSet = new Set(closingIds);
  return (
    <section data-testid="herdr-sessions" aria-label="Herdr sessions" style={{ borderTop: `1px solid ${border}`, paddingTop: 8, ...style }}>
      <h3 style={{ color: muted, fontSize: 11, fontWeight: 600, letterSpacing: 0.4, margin: "0 0 4px", padding: "0 12px", textTransform: "uppercase" }}>
        Herdr sessions
      </h3>
      {error ? <p role="alert" style={{ color: muted, fontSize: 12, margin: "0 12px 6px" }}>{error}</p> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {list.sessions.map((session) => {
          const selected = selectedRefKey === herdrSessionRefKey(session);
          const closing = closingSet.has(session.id);
          const confirming = confirmingId === session.id;
          return (
            <li key={session.id} data-herdr-session={session.id} style={{ borderBottom: `1px solid ${border}` }}>
              <div style={{ alignItems: "center", display: "flex", gap: 8, minHeight: 40, padding: "0 8px 0 12px" }}>
                <button
                  type="button"
                  aria-label={`Open ${session.title}`}
                  aria-current={selected || undefined}
                  onClick={() => onOpen(session)}
                  style={{
                    alignItems: "center", background: "transparent", border: "none", color: "inherit", cursor: "pointer",
                    display: "flex", flex: 1, gap: 8, minWidth: 0, padding: "6px 0", textAlign: "left",
                    fontWeight: selected ? 600 : 400,
                  }}
                >
                  <TerminalStatusDot status={terminalVisualStatus(session.status ?? undefined) ?? "idle"} testId={`herdr-session-status-${session.id}`} />
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</span>
                    {session.statusMessage ? (
                      <span style={{ color: muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.statusMessage}</span>
                    ) : null}
                  </span>
                </button>
                {confirming ? null : (
                  <Button variant="ghost" size="sm" aria-label={`Close ${session.title}`} disabled={closing}
                    onClick={() => setConfirmingId(session.id)}>
                    Close
                  </Button>
                )}
              </div>
              {confirming ? (
                <div role="group" aria-label={`Confirm closing ${session.title}`}
                  style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, padding: "0 8px 8px 12px" }}>
                  <span style={{ color: muted, flex: "1 1 100%", fontSize: 12 }}>Close this session? Its program ends in Herdr too.</span>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmingId(null)}>Cancel</Button>
                  <Button variant="destructive" size="sm" disabled={closing}
                    onClick={() => {
                      void onClose(session).then((ended) => { if (ended) setConfirmingId(null); });
                    }}>
                    {closing ? "Closing…" : "Close session"}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
