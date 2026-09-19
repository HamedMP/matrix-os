import { classifyTerminalPointerEvent } from "@matrix-os/contracts";

const TERMINAL_POINTER_EVENTS = ["mousedown", "mousemove", "mouseup"] as const;

interface TerminalSelectionReader {
  hasSelection(): boolean;
}

interface TerminalPointerInterceptionOptions {
  container: HTMLElement;
  getTerminal: () => TerminalSelectionReader | null;
  getVisualScale: () => number;
  shouldCorrectPointer?: (event: MouseEvent) => boolean;
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
  shouldCorrectPointer,
  correctPointer,
}: TerminalPointerInterceptionOptions): () => void {
  const ownerDocument = container.ownerDocument;
  let correctingPrimaryDrag = false;

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

    const shouldCorrect = shouldCorrectPointer?.(event) ?? getVisualScale() !== 1;
    if (event.type === "mousedown" && event.button === 0 && shouldCorrect) {
      correctingPrimaryDrag = true;
    }
    if (shouldCorrect) {
      correctPointer(event);
    }
    if (event.type === "mouseup" && event.button === 0) {
      correctingPrimaryDrag = false;
    }
  };

  const continuePrimaryDrag = (event: MouseEvent) => {
    if (!correctingPrimaryDrag) return;
    handler(event);
    if (event.type === "mouseup" && event.button === 0) correctingPrimaryDrag = false;
  };
  const cancelPrimaryDrag = () => { correctingPrimaryDrag = false; };

  for (const type of TERMINAL_POINTER_EVENTS) {
    container.addEventListener(type, handler, { capture: true });
  }
  ownerDocument.addEventListener("mousemove", continuePrimaryDrag, { capture: true });
  ownerDocument.addEventListener("mouseup", continuePrimaryDrag, { capture: true });
  ownerDocument.defaultView?.addEventListener("blur", cancelPrimaryDrag);

  return () => {
    for (const type of TERMINAL_POINTER_EVENTS) {
      container.removeEventListener(type, handler, { capture: true });
    }
    ownerDocument.removeEventListener("mousemove", continuePrimaryDrag, { capture: true });
    ownerDocument.removeEventListener("mouseup", continuePrimaryDrag, { capture: true });
    ownerDocument.defaultView?.removeEventListener("blur", cancelPrimaryDrag);
    correctingPrimaryDrag = false;
  };
}
