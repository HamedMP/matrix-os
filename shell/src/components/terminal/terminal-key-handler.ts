import { classifyTerminalClipboardShortcut } from "@matrix-os/contracts";

interface TerminalKeyHandlerOptions {
  isMac: boolean;
  getSelection: () => string;
  getCommandBlock: () => string;
  copy: (text: string) => void;
  paste: () => void;
  selectAll: () => void;
  toggleSearch: () => void;
  handleControls: (event: KeyboardEvent) => boolean;
}

/** Clipboard remains ahead of the shared editing/pane profile. */
export function createTerminalKeyHandler(options: TerminalKeyHandlerOptions) {
  return (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown" || event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return options.handleControls(event);
    const clipboardAction = classifyTerminalClipboardShortcut({
      type: "keydown", key: event.key, isMac: options.isMac,
      metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
      altKey: event.altKey, repeat: event.repeat, isComposing: event.isComposing,
      hasSelection: options.getSelection().length > 0,
    });
    if (clipboardAction) {
      event.preventDefault();
      if (clipboardAction === "copy") options.copy(options.getSelection());
      if (clipboardAction === "paste") options.paste();
      if (clipboardAction === "select-all") options.selectAll();
      return false;
    }
    if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key.toUpperCase() === "F") {
      event.preventDefault();
      if (!event.repeat) options.toggleSearch();
      return false;
    }
    if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && event.key.toUpperCase() === "C") {
      const block = options.getCommandBlock().trim();
      if (block) {
        event.preventDefault();
        if (!event.repeat) options.copy(block);
        return false;
      }
    }
    return options.handleControls(event);
  };
}
