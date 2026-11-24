import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { hasRegularDroppedFiles, regularDroppedFiles } from "../browser-views";

export type PaneShortcut = "toggle-details" | "find" | "back" | "forward" | "up" | "upload";

/** Maps a ⌘/Ctrl key press inside a folder pane to its command, or null. */
export function paneShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): PaneShortcut | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  switch (event.key) {
    case "i": case "I": return "toggle-details";
    case "f": case "F": return "find";
    case "[": return "back";
    case "]": return "forward";
    case "ArrowUp": return "up";
    case "u": case "U": return "upload";
    default: return null;
  }
}

/** Drag-and-drop of local files onto a folder listing, with the overlay state. Disabled for read-only folders. */
export function useDropUpload(enabled: boolean, onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [active, setActive] = useState(false);
  if (!enabled) return { active: false, handlers: {} };
  return {
    active,
    handlers: {
      onDragEnter: (event: DragEvent<HTMLDivElement>) => {
        if (!hasRegularDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      },
      onDragOver: (event: DragEvent<HTMLDivElement>) => { if (hasRegularDroppedFiles(event.dataTransfer)) event.preventDefault(); },
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        if (!hasRegularDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        depth.current = 0;
        setActive(false);
        onFiles(regularDroppedFiles(event.dataTransfer));
      },
    },
  };
}
