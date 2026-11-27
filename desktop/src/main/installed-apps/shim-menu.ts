// The menu bar macOS shows while an installed app's shim is active (spec 2711
// "User Journey" 4). Matrix's own menu and accelerators do not apply there, so
// it also carries the standard Edit and Window menus. Roles act on the shim.
import type { MenuItemConstructorOptions } from "electron";
import { bundleDisplayName } from "./mac-bundle";

export interface ShimMenuActions {
  reload(): void;
  openInMatrix(): void;
  showInFinder(): void;
  uninstall(): void;
}

/** `appName` is the install's name; the menu shows it as Finder and the Dock do, anti-spoof suffix included. */
export function shimMenuTemplate(appName: string, actions: ShimMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: bundleDisplayName(appName),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => actions.reload() },
        { label: "Open in Matrix", click: () => actions.openInMatrix() },
        { label: "Show in Finder", click: () => actions.showInFinder() },
        { type: "separator" },
        { label: "Uninstall…", click: () => actions.uninstall() },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
}
