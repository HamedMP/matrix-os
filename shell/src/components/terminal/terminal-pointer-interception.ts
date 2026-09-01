import { classifyTerminalPointerEvent } from "@matrix-os/contracts";

const TERMINAL_POINTER_EVENTS = ["mousedown", "mousemove", "mouseup"] as const;

interface TerminalSelectionReader {
  hasSelection(): boolean;
}

interface TerminalPointerInterceptionOptions {
  container: HTMLElement;
  getTerminal: () => TerminalSelectionReader | null;
  getVisualScale: () => number;
  correctPointer: (event: MouseEvent) => void;
}

type ZoomCorrectedMouseEvent = MouseEvent & { _xtermZoomCorrected?: boolean };

export function markTerminalZoomCorrected(event: MouseEvent): void {
  Object.defineProperty(event, "_xtermZoomCorrected", { value: true });
}

export function installTerminalPointerInterception({
  container,
  getTerminal,
  getVisualScale,
  correctPointer,
}: TerminalPointerInterceptionOptions): () => void {
  const handler = (event: MouseEvent) => {
    if ((event as ZoomCorrectedMouseEvent)._xtermZoomCorrected) return;

    const terminal = getTerminal();
    if (terminal) {
      const decision = classifyTerminalPointerEvent({
        type: event.type as (typeof TERMINAL_POINTER_EVENTS)[number],
        button: event.button,
        buttons: event.buttons,
        hasSelection: terminal.hasSelection(),
      });
      if (decision === "shield-selection") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }

    if (getVisualScale() !== 1) {
      correctPointer(event);
    }
  };

  for (const type of TERMINAL_POINTER_EVENTS) {
    container.addEventListener(type, handler, { capture: true });
  }

  return () => {
    for (const type of TERMINAL_POINTER_EVENTS) {
      container.removeEventListener(type, handler, { capture: true });
    }
  };
}
