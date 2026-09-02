export interface SoftGridLayoutInput {
  viewportWidth: number;
  viewportHeight: number;
  gridWidth: number;
  gridHeight: number;
  configuredFontSize: number;
  minimumReadableFontSize: number;
  devicePixelRatio?: number;
}

export interface SoftGridLayout {
  fontSize: number;
  scale: number;
  visualWidth: number;
  visualHeight: number;
  panX: boolean;
  panY: boolean;
}

const DIMENSION_EPSILON = 0.5;

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Computes presentation-only scaling for a server-sized terminal grid.
 * The readable floor wins over fit, after which overflow becomes pan instead
 * of shrinking glyphs further. The logical xterm cols/rows are never involved.
 */
export function computeSoftGridLayout(input: SoftGridLayoutInput): SoftGridLayout {
  const viewportWidth = positiveFinite(input.viewportWidth, input.gridWidth);
  const viewportHeight = positiveFinite(input.viewportHeight, input.gridHeight);
  const gridWidth = positiveFinite(input.gridWidth, viewportWidth);
  const gridHeight = positiveFinite(input.gridHeight, viewportHeight);
  const configuredFontSize = positiveFinite(input.configuredFontSize, 1);
  const minimumReadableFontSize = Math.min(
    configuredFontSize,
    positiveFinite(input.minimumReadableFontSize, configuredFontSize),
  );
  const devicePixelRatio = positiveFinite(input.devicePixelRatio ?? 1, 1);
  const fitScale = Math.min(1, viewportWidth / gridWidth, viewportHeight / gridHeight);
  const readableScale = minimumReadableFontSize / configuredFontSize;
  const overallScale = Math.max(fitScale, readableScale);
  const desiredFontSize = configuredFontSize * overallScale;
  const fontSize = Math.min(
    configuredFontSize,
    Math.max(
      minimumReadableFontSize,
      Math.ceil(desiredFontSize * devicePixelRatio - 1e-6) / devicePixelRatio,
    ),
  );
  const fontScale = fontSize / configuredFontSize;
  const scale = overallScale / fontScale;
  const visualWidth = gridWidth * fontScale * scale;
  const visualHeight = gridHeight * fontScale * scale;

  return {
    fontSize,
    scale,
    visualWidth,
    visualHeight,
    panX: visualWidth - viewportWidth > DIMENSION_EPSILON,
    panY: visualHeight - viewportHeight > DIMENSION_EPSILON,
  };
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
