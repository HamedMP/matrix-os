import {
  formatBinding,
  type BindingRejection,
  type ShortcutPlatform,
} from "@matrix-os/contracts/keyboard-shortcuts";

export const SHORTCUT_COPY = {
  description: "Change how you control Matrix from the keyboard. Saved on this computer.",
  searchLabel: "Search shortcuts",
  searchPlaceholder: "Search shortcuts…",
  clearSearch: "Clear search",
  addShortcut: "Add shortcut",
  reset: "Reset",
  replace: "Replace",
  cancel: "Cancel",
  restoreAll: "Restore all defaults",
  recording: "Press keys…",
  limit: "An action can have up to 4 shortcuts.",
  saveFailed: "Could not save shortcut. Please try again.",
  switchGroupTitle: "Switch to app 1–9",
  switchGroupDescription: "Go to an app by its place in the taskbar.",
  restoreTitle: "Restore all default shortcuts?",
  restoreBody: "Your custom shortcuts will be removed.",
  restoreConfirm: "Restore defaults",
} as const;

export const GROUP_TITLES = {
  apps: "Apps",
  navigation: "Navigation",
  tabs: "Tabs",
  chat: "Chat",
  terminal: "Terminal",
  "terminal-window": "Terminal window",
} as const;

/** Inline text for a binding: "⌃⇥" on macOS, "Ctrl+Tab" elsewhere. */
export function bindingText(binding: string, platform: ShortcutPlatform): string {
  return formatBinding(binding, platform).join(platform === "mac" ? "" : "+");
}

const SPOKEN_PARTS: Record<ShortcutPlatform, Readonly<Record<string, string>>> = {
  mac: { Cmd: "Command", Ctrl: "Control", Alt: "Option" },
  other: { Ctrl: "Control" },
};

/** Screen-reader name for a binding, e.g. "Control Tab". */
export function spokenBinding(binding: string, platform: ShortcutPlatform): string {
  return binding
    .split("+")
    .map((part) => SPOKEN_PARTS[platform][part] ?? part)
    .join(" ");
}

export function emptySearchMessage(query: string): string {
  return `No shortcuts match “${query}”.`;
}

export function removeLabel(binding: string, platform: ShortcutPlatform): string {
  return `Remove ${bindingText(binding, platform)}`;
}

export function recordingLabel(actionLabel: string): string {
  return `Recording shortcut for ${actionLabel}`;
}

export function conflictMessage(binding: string, ownerLabel: string, platform: ShortcutPlatform): string {
  return `${bindingText(binding, platform)} is used by ${ownerLabel}.`;
}

export function rejectionMessage(binding: string, rejection: BindingRejection, platform: ShortcutPlatform): string {
  const text = bindingText(binding, platform);
  switch (rejection.reason) {
    case "reserved-system":
      return platform === "mac" ? `${text} is reserved by macOS.` : `${text} is reserved by the system.`;
    case "reserved-menu":
      return `${text} is reserved for ${rejection.role}.`;
    case "needs-modifier":
      return platform === "mac" ? "Add a modifier key such as ⌘ or ⌃." : "Add a modifier key such as Ctrl or Alt.";
    case "invalid":
      return "That key can’t be used in a shortcut.";
  }
}
