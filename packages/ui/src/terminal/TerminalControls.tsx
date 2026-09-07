import React, { useState, type CSSProperties } from "react";
import {
  TERMINAL_COMMANDS,
  TERMINAL_COMMAND_LABELS,
  terminalBindings,
  type TerminalKeyboardPreferences,
  type TerminalPaneAction,
} from "@matrix-os/contracts";
import type { TerminalControlsState } from "./use-terminal-controls.js";
const buttonStyle: CSSProperties = {
  font: "inherit",
  fontSize: 12,
  color: "inherit",
  background: "transparent",
  border: "1px solid currentColor",
  borderRadius: 5,
  padding: "3px 7px",
  cursor: "pointer",
};
const ACTIONS: Array<{
  label: string;
  action: TerminalPaneAction;
}> = [
  { label: "Split right", action: { type: "split", direction: "right" } },
  { label: "Split below", action: { type: "split", direction: "down" } },
  ...(["left", "up", "down", "right"] as const).map((direction) => ({
    label: `Focus ${direction}`,
    action: { type: "focus" as const, direction },
  })),
  { label: "Maximize / restore", action: { type: "fullscreen" } },
];
export function TerminalControls({
  controls,
}: {
  controls: TerminalControlsState;
}) {
  const [draft, setDraft] = useState(controls.preferences);
  const [closing, setClosing] = useState(false);
  const [previousPreferences, setPreviousPreferences] = useState(
    controls.preferences,
  );
  if (previousPreferences !== controls.preferences) {
    setPreviousPreferences(controls.preferences);
    if (draft === previousPreferences) setDraft(controls.preferences);
  }
  const target = `${controls.enabled}:${controls.sessionName ?? ""}`;
  const [previousTarget, setPreviousTarget] = useState(target);
  if (previousTarget !== target) {
    setPreviousTarget(target);
    setClosing(false);
  }
  const bindings = terminalBindings(draft, controls.isMac);
  return (
    <div
      data-testid="terminal-controls"
      style={{
        fontFamily: "inherit",
        fontSize: 12,
        color: "inherit",
        padding: "4px 8px",
        flexShrink: 0,
        borderBottom:
          "1px solid color-mix(in srgb, currentColor 15%, transparent)",
      }}
    >
      <div
        role="toolbar"
        aria-label="Terminal pane controls"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          flexWrap: "wrap",
        }}
      >
        {ACTIONS.map(({ label, action }) => (
          <button
            type="button"
            style={buttonStyle}
            key={label}
            disabled={!controls.paneActionsEnabled || controls.busy}
            onClick={() => void controls.runAction(action)}
          >
            {label}
          </button>
        ))}
        <details>
          <summary style={{ cursor: "pointer" }}>More pane actions</summary>
          <div
            style={{ display: "flex", gap: 5, flexWrap: "wrap", padding: 6 }}
          >
            {(["left", "right", "up", "down"] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                style={buttonStyle}
                disabled={!controls.paneActionsEnabled || controls.busy}
                onClick={() =>
                  void controls.runAction({ type: "resize", direction })
                }
              >
                Resize {direction}
              </button>
            ))}
            {(["top", "bottom"] as const).map((edge) => (
              <button
                key={edge}
                type="button"
                style={buttonStyle}
                disabled={!controls.paneActionsEnabled || controls.busy}
                onClick={() =>
                  void controls.runAction({ type: "scroll", edge })
                }
              >
                History {edge}
              </button>
            ))}
            <button
              type="button"
              style={buttonStyle}
              disabled={!controls.paneActionsEnabled || controls.busy}
              onClick={() => setClosing(true)}
            >
              Close pane
            </button>
          </div>
        </details>
        <details>
          <summary style={{ cursor: "pointer" }}>Keyboard shortcuts</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void controls.savePreferences(draft);
            }}
            style={{ padding: 8, maxHeight: 280, overflow: "auto" }}
          >
            <label>
              Shortcut profile{" "}
              <select
                aria-label="Shortcut profile"
                disabled={controls.saving}
                value={draft.profile}
                onChange={(e) =>
                  setDraft({
                    profile: e.target
                      .value as TerminalKeyboardPreferences["profile"],
                    overrides: {},
                  })
                }
              >
                <option value="mac">Mac editing</option>
                <option value="standard">Standard terminal</option>
                <option value="passthrough">Pass through to application</option>
              </select>
            </label>
            <p>
              Ctrl+G, then H/J/K/L or arrows: focus. V/S: split right/below. F:
              maximize. X: close. T/B: history. Shift+arrows: resize. Escape
              cancels; prefix expires after 2 seconds.
            </p>
            <p>
              Use Ctrl, Alt, Shift, Meta (Command), for example Meta+ArrowLeft.
              Empty disables a shortcut. Browser shortcuts may require the
              prefix alternative.
            </p>
            {TERMINAL_COMMANDS.map((command) => (
              <label
                key={command}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 4,
                }}
              >
                {TERMINAL_COMMAND_LABELS[command]}
                <input
                  aria-label={TERMINAL_COMMAND_LABELS[command]}
                  maxLength={64}
                  value={bindings[command] ?? ""}
                  disabled={controls.saving || draft.profile === "passthrough"}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      overrides: {
                        ...draft.overrides,
                        [command]: e.target.value || null,
                      },
                    })
                  }
                />
              </label>
            ))}
            <button
              type="submit"
              style={buttonStyle}
              disabled={!controls.enabled || controls.saving}
            >
              Save shortcuts
            </button>{" "}
            <button
              type="button"
              style={buttonStyle}
              disabled={controls.saving}
              onClick={() => setDraft({ profile: "mac", overrides: {} })}
            >
              Reset defaults
            </button>
          </form>
        </details>
      </div>
      {closing && (
        <div role="alertdialog" aria-label="Close terminal pane">
          Closing ends the process in this pane.{" "}
          <button
            type="button"
            onClick={() => {
              setClosing(false);
              void controls.runAction({ type: "close" });
            }}
          >
            Close this pane
          </button>{" "}
          <button type="button" onClick={() => setClosing(false)}>
            Cancel
          </button>
        </div>
      )}
      {controls.prefixActive && (
        <div role="status">
          Pane command: H/J/K/L focus · V/S split · F maximize · X close · Esc
          cancel
        </div>
      )}
      {controls.error && <div role="alert">{controls.error}</div>}
    </div>
  );
}
