// Herdr's Terminal window shortcuts as menu accelerators (spec 2706). They
// are in the application menu only while the Terminal window has focus, so
// the main window keeps every key it uses today.
import type { MenuItemConstructorOptions } from "electron";
import type { TerminalWindowCommand } from "../../shared/terminal-window";

export function terminalWindowMenuItems(
  command: (command: TerminalWindowCommand) => void,
  closeWindow: () => void,
  isMac: boolean,
): MenuItemConstructorOptions[] {
  // Herdr's keys are macOS ones; elsewhere the Super key stands in, so Ctrl stays with the shell.
  const key = (keys: string) => keys.replace(/^Cmd\+/, isMac ? "Cmd+" : "Super+");
  const item = (label: string, accelerator: string, sent: TerminalWindowCommand): MenuItemConstructorOptions => ({
    label, accelerator: key(accelerator), click: () => command(sent),
  });
  const directions = [["Left", "left"], ["Right", "right"], ["Up", "up"], ["Down", "down"]] as const;
  return [
    item("New Terminal", "Cmd+N", { command: "new-terminal" }),
    { ...item("New Terminal", "Cmd+T", { command: "new-terminal" }), visible: false, acceleratorWorksWhenHidden: true },
    // Herdr's Cmd+W closes the focused pane, ending its terminal (it asks first while a program runs).
    item("Close Pane", "Cmd+W", { command: "close-terminal" }),
    { label: "Close Window", accelerator: key("Cmd+Alt+W"), click: closeWindow },
    { type: "separator" },
    item("Rename Terminal…", "F2", { command: "rename" }),
    item("Find…", "Cmd+F", { command: "find" }),
    { type: "separator" },
    item("Go to Terminal…", "Cmd+P", { command: "picker" }),
    item("Overview", "Cmd+Shift+O", { command: "overview" }),
    { ...item("Commands…", "Cmd+Shift+P", { command: "picker" }), visible: false, acceleratorWorksWhenHidden: true },
    item("Next Terminal", "Cmd+]", { command: "next" }),
    item("Previous Terminal", "Cmd+[", { command: "previous" }),
    // Ctrl+Tab cycles the open tabs in the tab bar, as Herdr's does.
    item("Next Tab", "Ctrl+Tab", { command: "next-tab" }),
    item("Previous Tab", "Ctrl+Shift+Tab", { command: "previous-tab" }),
    {
      label: "Select Terminal",
      submenu: Array.from({ length: 9 }, (_, offset) => item(`Terminal ${offset + 1}`, `Cmd+${offset + 1}`, { command: "select", index: offset + 1 })),
    },
    {
      // Ctrl, not Cmd, on every platform: Cmd+digits pick a terminal within the space.
      label: "Switch Space",
      submenu: [
        { label: "All Spaces", accelerator: "Ctrl+0", click: () => command({ command: "space", index: 0 }) },
        ...Array.from({ length: 9 }, (_, offset): MenuItemConstructorOptions => ({
          label: `Space ${offset + 1}`, accelerator: `Ctrl+${offset + 1}`, click: () => command({ command: "space", index: offset + 1 }),
        })),
      ],
    },
    { type: "separator" },
    item("Split Right", "Cmd+D", { command: "split-right" }),
    item("Split Down", "Cmd+Shift+D", { command: "split-down" }),
    // Takes the pane off screen; its terminal keeps running in the sidebar.
    item("Hide Pane", "Cmd+Shift+W", { command: "close-pane" }),
    item("Zoom Pane", "Cmd+Shift+Enter", { command: "zoom-pane" }),
    {
      label: "Focus Pane",
      submenu: directions.map(([label, direction]) => item(label, `Cmd+Alt+${label}`, { command: "focus-pane", direction })),
    },
    {
      label: "Swap Pane",
      submenu: directions.map(([label, direction]) => item(label, `Cmd+Alt+Shift+${label}`, { command: "swap-pane", direction })),
    },
    { type: "separator" },
    item("Toggle Sidebar", "Cmd+B", { command: "toggle-sidebar" }),
  ];
}

/**
 * The keys the Terminal window's own menu uses. While that window has focus the
 * main window's Apps shortcuts (Ctrl+Tab, Cmd+digits) must not take them first.
 */
export function terminalWindowBindings(isMac: boolean): ReadonlySet<string> {
  const keys = new Set<string>();
  const collect = (items: MenuItemConstructorOptions[]) => {
    for (const entry of items) {
      if (typeof entry.accelerator === "string") keys.add(entry.accelerator);
      if (Array.isArray(entry.submenu)) collect(entry.submenu);
    }
  };
  collect(terminalWindowMenuItems(() => undefined, () => undefined, isMac));
  return keys;
}
