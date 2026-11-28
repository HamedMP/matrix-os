/**
 * The system clipboard for actions started by a click (menu items, toolbar
 * buttons). Keyboard shortcuts do not come here: they arrive as clipboard
 * events, which need no permission. A browser that refuses is reported as
 * false or null, never as an exception.
 */

import type { ClipboardPayload } from "./actions-clipboard";

/**
 * Puts text and an HTML table on the clipboard through the browser's own copy
 * command: the command raises a `copy` event, and filling that event needs no
 * permission, also in a sandboxed frame. Call it from a click. False when the
 * browser has no such command or did not raise the event.
 */
export function commandClipboard(payload: ClipboardPayload): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  let written = false;
  const write = (event: ClipboardEvent): void => {
    if (event.clipboardData === null) return;
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
    event.preventDefault();
    // The grid's own copy handler must not answer this event a second time.
    event.stopPropagation();
    written = true;
  };
  // Without a text selection some browsers ask first whether the page handles the copy.
  const allow = (event: Event): void => event.preventDefault();
  document.addEventListener("copy", write, true);
  document.addEventListener("beforecopy", allow, true);
  try {
    document.execCommand("copy");
  } catch (error: unknown) {
    console.warn("the browser copy command failed", error instanceof Error ? error.name : "error");
  } finally {
    document.removeEventListener("copy", write, true);
    document.removeEventListener("beforecopy", allow, true);
  }
  return written;
}

/** Puts text and an HTML table on the clipboard. False when the browser refused. */
export async function writeSystemClipboard(payload: ClipboardPayload): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) return false;
    if (typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ]);
    } else {
      await clipboard.writeText(payload.text);
    }
    return true;
  } catch (error: unknown) {
    console.warn("clipboard write was refused", error instanceof Error ? error.name : "error");
    return false;
  }
}

async function readType(items: readonly ClipboardItem[], type: string): Promise<string | null> {
  const item = items.find((entry) => entry.types.includes(type));
  return item === undefined ? null : (await item.getType(type)).text();
}

/** Reads text and HTML from the clipboard. Null when the browser refused. */
export async function readSystemClipboard(): Promise<{ text: string; html: string | null } | null> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) return null;
    if (typeof clipboard.read !== "function") return { text: await clipboard.readText(), html: null };
    const items = await clipboard.read();
    const [text, html] = await Promise.all([readType(items, "text/plain"), readType(items, "text/html")]);
    return { text: text ?? "", html };
  } catch (error: unknown) {
    console.warn("clipboard read was refused", error instanceof Error ? error.name : "error");
    return null;
  }
}
