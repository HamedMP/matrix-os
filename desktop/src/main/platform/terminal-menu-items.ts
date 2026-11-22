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
  return [
    item("New Terminal", "Cmd+T", { command: "new-terminal" }),
    item("Close Terminal", "Cmd+W", { command: "close-terminal" }),
    { label: "Close Window", accelerator: key("Cmd+Alt+W"), click: closeWindow },
    { type: "separator" },
    item("Rename Terminal…", "F2", { command: "rename" }),
    item("Find…", "Cmd+F", { command: "find" }),
    { type: "separator" },
    item("Go to Terminal…", "Cmd+P", { command: "picker" }),
    item("Next Terminal", "Cmd+]", { command: "next" }),
    item("Previous Terminal", "Cmd+[", { command: "previous" }),
    // Ctrl+Tab cycles like Herdr's; it is hidden so the menu shows one entry per action.
    { ...item("Next Terminal", "Ctrl+Tab", { command: "next" }), visible: false, acceleratorWorksWhenHidden: true },
    { ...item("Previous Terminal", "Ctrl+Shift+Tab", { command: "previous" }), visible: false, acceleratorWorksWhenHidden: true },
    {
      label: "Select Terminal",
      submenu: Array.from({ length: 9 }, (_, offset) => item(`Terminal ${offset + 1}`, `Cmd+${offset + 1}`, { command: "select", index: offset + 1 })),
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
