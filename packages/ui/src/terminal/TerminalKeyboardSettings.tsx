import React, { type Dispatch, type SetStateAction } from "react";
import {
  TERMINAL_COMMANDS,
  TERMINAL_COMMAND_LABELS,
  terminalBindings,
  type TerminalKeyboardPreferences,
} from "@matrix-os/contracts";
import type { TerminalControlsState } from "./use-terminal-controls.js";

export function TerminalKeyboardSettings({
  controls,
  draft,
  setDraft,
}: {
  controls: TerminalControlsState;
  draft: TerminalKeyboardPreferences;
  setDraft: Dispatch<SetStateAction<TerminalKeyboardPreferences>>;
}) {
  const bindings = terminalBindings(draft, controls.isMac);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void controls.savePreferences(draft);
      }}
      className="matrix-terminal-shortcuts"
    >
      <label>
        Shortcut profile{" "}
        <select
          aria-label="Shortcut profile"
          disabled={controls.saving}
          value={draft.profile}
          onChange={(e) =>
            setDraft({
              profile: e.target.value as TerminalKeyboardPreferences["profile"],
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
        maximize. X: close. T/B: history. Shift+arrows: resize. Escape cancels;
        prefix expires after 2 seconds.
      </p>
      <p>
        Use Ctrl, Alt, Shift, Meta (Command), for example Meta+ArrowLeft. Empty
        disables a shortcut. Browser shortcuts may require the prefix
        alternative.
      </p>
      {TERMINAL_COMMANDS.map((command) => (
        <label key={command} className="matrix-terminal-binding">
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
        className="matrix-terminal-button"
        disabled={!controls.enabled || controls.saving}
      >
        Save shortcuts
      </button>{" "}
      <button
        type="button"
        className="matrix-terminal-button"
        disabled={controls.saving}
        onClick={() => setDraft({ profile: "mac", overrides: {} })}
      >
        Reset defaults
      </button>
    </form>
  );
}
