// The Terminal window's shortcuts as menu accelerators (spec 2706). They are
// in the application menu only while the Terminal window has focus, so the
// main window keeps every key it uses. Each command is a registry action
// (group "terminal-window"), so its keys follow the person's Shortcuts
// settings; selecting a terminal (Cmd+1…9) and a space (Ctrl+0…9) are fixed
// keys, like the main window's app switching digits.
import type { MenuItemConstructorOptions } from "electron";
import type { EffectiveShortcuts, ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";
import { terminalWindowFixedKeys, type TerminalWindowCommand } from "../../shared/terminal-window";

type Direction = "left" | "right" | "up" | "down";
const DIRECTIONS: ReadonlyArray<[label: string, direction: Direction]> = [["Left", "left"], ["Right", "right"], ["Up", "up"], ["Down", "down"]];

export function terminalWindowMenuItems(
  shortcuts: EffectiveShortcuts,
  command: (command: TerminalWindowCommand) => void,
  closeWindow: () => void,
  isMac: boolean,
): MenuItemConstructorOptions[] {
  // The first binding shows; the others work hidden, as the main window's menu does.
  const item = (id: ShortcutActionId, label: string, click: () => void): MenuItemConstructorOptions[] => {
    const [first, ...rest] = shortcuts[id] ?? [];
    return [
      { label, ...(first ? { accelerator: first } : {}), click },
      ...rest.map((accelerator): MenuItemConstructorOptions => ({ label, accelerator, visible: false, acceleratorWorksWhenHidden: true, click })),
    ];
  };
  const run = (id: ShortcutActionId, label: string, sent: TerminalWindowCommand) => item(id, label, () => command(sent));
  const fixed = terminalWindowFixedKeys(isMac);
  return [
    ...run("terminal-window.new", "New Terminal", { command: "new-terminal" }),
    // Herdr's Cmd+W closes the focused pane, ending its terminal (it asks first while a program runs).
    ...run("terminal-window.close-pane", "Close Pane", { command: "close-terminal" }),
    ...item("terminal-window.close-window", "Close Window", closeWindow),
    { type: "separator" },
    ...run("terminal-window.rename", "Rename Terminal…", { command: "rename" }),
    ...run("terminal-window.find", "Find…", { command: "find" }),
    { type: "separator" },
    ...run("terminal-window.picker", "Go to Terminal…", { command: "picker" }),
    ...run("terminal-window.overview", "Overview", { command: "overview" }),
    ...run("terminal-window.next", "Next Terminal", { command: "next" }),
    ...run("terminal-window.previous", "Previous Terminal", { command: "previous" }),
    // Ctrl+Tab cycles the open tabs in the tab bar, as Herdr's does.
    ...run("terminal-window.next-tab", "Next Tab", { command: "next-tab" }),
    ...run("terminal-window.previous-tab", "Previous Tab", { command: "previous-tab" }),
    {
      label: "Select Terminal",
      submenu: fixed.select.map((accelerator, offset): MenuItemConstructorOptions => ({
        label: `Terminal ${offset + 1}`, accelerator, click: () => command({ command: "select", index: offset + 1 }),
      })),
    },
    {
      // Ctrl, not Cmd, on every platform: Cmd+digits pick a terminal within the space.
      label: "Switch Space",
      submenu: fixed.space.map((accelerator, digit): MenuItemConstructorOptions => ({
        label: digit === 0 ? "All Spaces" : `Space ${digit}`, accelerator, click: () => command({ command: "space", index: digit }),
      })),
    },
    { type: "separator" },
    ...run("terminal-window.split-right", "Split Right", { command: "split-right" }),
    ...run("terminal-window.split-down", "Split Down", { command: "split-down" }),
    // Takes the pane off screen; its terminal keeps running in the sidebar.
    ...run("terminal-window.hide-pane", "Hide Pane", { command: "close-pane" }),
    ...run("terminal-window.zoom-pane", "Zoom Pane", { command: "zoom-pane" }),
    {
      label: "Focus Pane",
      submenu: DIRECTIONS.flatMap(([label, direction]) => run(`terminal-window.focus-${direction}`, label, { command: "focus-pane", direction })),
    },
    {
      label: "Swap Pane",
      submenu: DIRECTIONS.flatMap(([label, direction]) => run(`terminal-window.swap-${direction}`, label, { command: "swap-pane", direction })),
    },
    { type: "separator" },
    ...run("terminal-window.toggle-sidebar", "Toggle Sidebar", { command: "toggle-sidebar" }),
  ];
}
