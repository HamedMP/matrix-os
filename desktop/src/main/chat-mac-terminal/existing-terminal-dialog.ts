import { Menu, type BrowserWindow } from "electron";
import type { MacTerminalContext } from "../chat-electron-preview/transport";
import { showMacActivityDialog } from "../mac-activity/dialog";

interface TerminalChoice { id: string; title: string }

export function pickExistingMacTerminal(
  window: BrowserWindow, terminals: readonly TerminalChoice[], signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted || window.isDestroyed()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(selected: string | null) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(selected);
    }
    const menu = Menu.buildFromTemplate([
      { label: "Choose a Mac terminal", enabled: false },
      { type: "separator" },
      ...terminals.map(terminal => ({
        id: `mac-existing-terminal-${terminal.id}`,
        label: `${terminal.title} (${terminal.id})`,
        click: () => finish(terminal.id),
      })),
    ]);
    function onAbort() {
      finish(null);
      if (!window.isDestroyed()) menu.closePopup(window);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      menu.popup({ window, callback: () => { setImmediate(() => finish(null)); } });
    } catch (error: unknown) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

export async function approveExistingMacTerminal(
  window: BrowserWindow, context: MacTerminalContext, terminal: TerminalChoice, output: string, signal: AbortSignal,
): Promise<boolean> {
  if (window.isDestroyed() || signal.aborted) return false;
  const result = await showMacActivityDialog(window, {
    type: "question",
    message: "Use Mac terminal output in this Chat?",
    detail: [
      `Terminal ${terminal.title} (${terminal.id})`,
      `Chat ${context.chatId} · Worktree ${context.worktreeId}`,
      "This screen will be added to your draft. Review it before choosing whether to send it.",
      output,
    ].join("\n\n"),
    buttons: ["Cancel", "Use in Chat"],
    cancelId: 0,
    defaultId: 0,
    signal,
  });
  return result.response === 1;
}
