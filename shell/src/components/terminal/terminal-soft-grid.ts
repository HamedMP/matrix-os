export { computeSoftGridLayout, type SoftGridLayout, type SoftGridLayoutInput } from "@matrix-os/ui";

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface TerminalPointerCoordinatesInput {
  clientX: number;
  clientY: number;
  rectLeft: number;
  rectTop: number;
  canvasZoom: number;
  gridScale: number;
}

export interface TerminalPointerCorrectionDecisionInput {
  type: "mousedown" | "mousemove" | "mouseup" | "contextmenu";
  alreadyCorrected: boolean;
  visualScale: number;
}

/** Keeps screen-space menu events raw while correcting xterm cell events once. */
export function shouldCorrectTerminalPointerCoordinates(
  input: TerminalPointerCorrectionDecisionInput,
): boolean {
  return input.type !== "contextmenu"
    && !input.alreadyCorrected
    && Number.isFinite(input.visualScale)
    && input.visualScale > 0
    && input.visualScale !== 1;
}

/** Maps pointer coordinates back through every visual terminal transform. */
export function correctTerminalPointerCoordinates(input: TerminalPointerCoordinatesInput): {
  clientX: number;
  clientY: number;
} {
  const canvasZoom = positiveFinite(input.canvasZoom, 1);
  const gridScale = positiveFinite(input.gridScale, 1);
  const visualScale = canvasZoom * gridScale;
  return {
    clientX: input.rectLeft + (input.clientX - input.rectLeft) / visualScale,
    clientY: input.rectTop + (input.clientY - input.rectTop) / visualScale,
  };
}
