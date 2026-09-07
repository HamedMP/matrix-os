import React, { useRef, useState, type CSSProperties } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { TerminalPaneAction } from "@matrix-os/contracts";
import type { TerminalControlsState } from "./use-terminal-controls.js";
import {
  TerminalControlIcon,
  type TerminalControlIconName,
} from "./TerminalControlIcon.js";
import { TerminalKeyboardSettings } from "./TerminalKeyboardSettings.js";
import "./terminal-controls.css";

const PRIMARY_ACTIONS: Array<{
  label: string;
  icon: TerminalControlIconName;
  action: TerminalPaneAction;
}> = [
  {
    label: "Split right",
    icon: "split-right",
    action: { type: "split", direction: "right" },
  },
  {
    label: "Split below",
    icon: "split-down",
    action: { type: "split", direction: "down" },
  },
  {
    label: "Maximize / restore",
    icon: "maximize",
    action: { type: "fullscreen" },
  },
];
const DIRECTIONS = ["left", "down", "up", "right"] as const;

export function TerminalControls({
  controls,
  theme,
}: {
  controls: TerminalControlsState;
  theme?: { background?: string; foreground?: string };
}) {
  const [draft, setDraft] = useState(controls.preferences);
  const [closing, setClosing] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const skipMenuFocus = useRef(false);
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
    setMenuOpen(false);
    setShortcutsOpen(false);
  }
  // Portals need the same explicit terminal palette as the inline controls.
  const palette = {
    "--terminal-control-bg":
      theme?.background ?? "var(--matrix-background, #101218)",
    "--terminal-control-fg": theme?.foreground ?? "var(--matrix-fg, #e4e4e7)",
  } as CSSProperties;
  const disabled = !controls.paneActionsEnabled || controls.busy;
  function runAction(action: TerminalPaneAction) {
    skipMenuFocus.current = true;
    void controls.runAction(action);
  }
  return (
    <div
      data-testid="terminal-controls"
      className="matrix-terminal-controls"
      style={palette}
    >
      <div
        role="group"
        aria-label="Terminal pane controls"
        className="matrix-terminal-toolbar"
      >
        <span className="matrix-terminal-hint" aria-hidden="true">
          Pane controls <kbd>⌃ G</kbd>
        </span>
        <div className="matrix-terminal-primary">
          {PRIMARY_ACTIONS.map(({ label, icon, action }) => (
            <button
              type="button"
              className="matrix-terminal-icon-button"
              key={label}
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => void controls.runAction(action)}
            >
              <TerminalControlIcon name={icon} />
            </button>
          ))}
        </div>
        <span className="matrix-terminal-divider" aria-hidden="true" />
        <Dialog.Root open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="matrix-terminal-icon-button"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts"
            >
              <TerminalControlIcon name="keyboard" />
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="matrix-terminal-overlay" />
            <Dialog.Content className="matrix-terminal-dialog" style={palette}>
              <div className="matrix-terminal-dialog-header">
                <Dialog.Title>Keyboard shortcuts</Dialog.Title>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="matrix-terminal-icon-button"
                    aria-label="Close keyboard shortcuts"
                  >
                    <TerminalControlIcon name="close" />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description>
                Customize editing and pane controls for your terminal.
              </Dialog.Description>
              <TerminalKeyboardSettings
                controls={controls}
                draft={draft}
                setDraft={setDraft}
              />
              {controls.error && (
                <p role="alert" className="matrix-terminal-error">
                  {controls.error}
                </p>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
          <Menu.Trigger asChild>
            <button
              ref={moreButton}
              type="button"
              className="matrix-terminal-icon-button"
              aria-label="More pane actions"
              title="More pane actions"
            >
              <TerminalControlIcon name="more" />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              className="matrix-terminal-menu"
              style={palette}
              align="end"
              sideOffset={6}
              collisionPadding={12}
              onCloseAutoFocus={(event) => {
                if (skipMenuFocus.current) event.preventDefault();
                skipMenuFocus.current = false;
              }}
            >
              {(["focus", "resize"] as const).map((type) => (
                <Menu.Group key={type}>
                  <Menu.Label>
                    {type === "focus" ? "Move focus" : "Resize pane"}
                  </Menu.Label>
                  {DIRECTIONS.map((direction) => (
                    <Menu.Item
                      key={direction}
                      disabled={disabled}
                      onSelect={() => runAction({ type, direction })}
                    >
                      <TerminalControlIcon name={direction} />
                      {type === "focus" ? "Focus" : "Resize"} {direction}
                    </Menu.Item>
                  ))}
                  <Menu.Separator />
                </Menu.Group>
              ))}
              {(["top", "bottom"] as const).map((edge) => (
                <Menu.Item
                  key={edge}
                  disabled={disabled}
                  onSelect={() => runAction({ type: "scroll", edge })}
                >
                  <TerminalControlIcon name={`history-${edge}`} />
                  History {edge}
                </Menu.Item>
              ))}
              <Menu.Separator />
              <Menu.Item
                disabled={disabled}
                className="matrix-terminal-destructive"
                onSelect={() => {
                  skipMenuFocus.current = true;
                  setClosing(true);
                }}
              >
                <TerminalControlIcon name="close" />
                Close pane
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      <Dialog.Root open={closing} onOpenChange={setClosing}>
        <Dialog.Portal>
          <Dialog.Overlay className="matrix-terminal-overlay" />
          <Dialog.Content
            role="alertdialog"
            className="matrix-terminal-dialog matrix-terminal-confirm"
            style={palette}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              moreButton.current?.focus();
            }}
          >
            <Dialog.Title>Close terminal pane</Dialog.Title>
            <Dialog.Description>
              Closing ends the process in this pane. Other panes stay open.
            </Dialog.Description>
            <div className="matrix-terminal-dialog-actions">
              <Dialog.Close asChild>
                <button type="button" className="matrix-terminal-button">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="matrix-terminal-button matrix-terminal-destructive"
                disabled={disabled}
                onClick={() => {
                  setClosing(false);
                  void controls.runAction({ type: "close" });
                }}
              >
                Close this pane
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {controls.prefixActive && (
        <div role="status" className="matrix-terminal-prefix">
          Pane command: H/J/K/L focus · V/S split · F maximize · X close · Esc
          cancel
        </div>
      )}
      {controls.error && !shortcutsOpen && (
        <div role="alert" className="matrix-terminal-error">
          {controls.error}
        </div>
      )}
    </div>
  );
}
