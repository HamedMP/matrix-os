/**
 * Where the onboarding widget sits on screen: offsets from its nearest viewport corner.
 * Anchoring to a corner keeps it put when the window resizes, and lets the card grow away
 * from that corner (up from a bottom anchor, down from a top anchor).
 */
export interface OnboardingWidgetPosition {
  x: "left" | "right";
  y: "top" | "bottom";
  /** CSS px from the `x` edge of the viewport to the widget. */
  dx: number;
  /** CSS px from the `y` edge of the viewport to the widget. */
  dy: number;
}

export interface OnboardingWidgetPlacement {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** A measured width and height in CSS px, of the widget or the window. */
export interface OnboardingWidgetBox {
  width: number;
  height: number;
}

type Size = OnboardingWidgetBox;

interface Rect extends Size {
  left: number;
  top: number;
}

export const ONBOARDING_CORNER_GAP = 24;
export const ONBOARDING_EDGE_GAP = 8;
export const ONBOARDING_POSITION_MAX = 10_000;
/** The support launcher's footprint from the bottom-right corner (24px inset, 44px button) plus a small gap. */
const SUPPORT_LAUNCHER_REACH = 72;

export const DEFAULT_ONBOARDING_POSITION: OnboardingWidgetPosition = Object.freeze({
  x: "right",
  y: "bottom",
  dx: ONBOARDING_CORNER_GAP,
  dy: ONBOARDING_CORNER_GAP,
});

export function onboardingCornerPosition(x: OnboardingWidgetPosition["x"]): OnboardingWidgetPosition {
  return { x, y: "bottom", dx: ONBOARDING_CORNER_GAP, dy: ONBOARDING_CORNER_GAP };
}

export function isOnboardingCornerPosition(position: OnboardingWidgetPosition): boolean {
  return position.y === "bottom" && position.dx === ONBOARDING_CORNER_GAP && position.dy === ONBOARDING_CORNER_GAP;
}

function edgeOffset(distance: number, span: number): number {
  const max = Math.min(ONBOARDING_POSITION_MAX, Math.max(ONBOARDING_EDGE_GAP, span));
  return Math.min(max, Math.max(ONBOARDING_EDGE_GAP, Math.round(distance)));
}

/** Converts where the widget was dropped into offsets from the corner nearest its center. */
export function onboardingPositionFromRect(rect: Rect, viewport: Size): OnboardingWidgetPosition {
  const x = rect.left + rect.width / 2 < viewport.width / 2 ? "left" : "right";
  const y = rect.top + rect.height / 2 < viewport.height / 2 ? "top" : "bottom";
  return {
    x,
    y,
    dx: edgeOffset(x === "left" ? rect.left : viewport.width - rect.left - rect.width, viewport.width),
    dy: edgeOffset(y === "top" ? rect.top : viewport.height - rect.top - rect.height, viewport.height),
  };
}

function fit(offset: number, size: number, span: number | undefined): number {
  const max = span === undefined ? offset : span - size - ONBOARDING_EDGE_GAP;
  return Math.max(ONBOARDING_EDGE_GAP, Math.min(offset, max));
}

/**
 * The CSS offsets that show the widget at its saved spot, pulled back so all of it stays on screen.
 * Without a viewport (server render, before hydration) the saved offsets are used as they are.
 */
export function onboardingPlacement(position: OnboardingWidgetPosition, size: Size, viewport: Size | null): OnboardingWidgetPlacement {
  const dx = fit(position.dx, size.width, viewport?.width);
  const dy = fit(position.dy, size.height, viewport?.height);
  return {
    ...(position.x === "left" ? { left: dx } : { right: dx }),
    ...(position.y === "top" ? { top: dy } : { bottom: dy }),
  };
}

/** CSS px from the widget to the viewport's right and bottom edges, where the support launcher lives. */
export interface OnboardingWidgetEdgeGaps {
  right: number;
  bottom: number;
}

/** The gaps a saved position implies before the widget is measured; an edge it is not anchored to counts as far away. */
export function onboardingEdgeGaps(position: OnboardingWidgetPosition): OnboardingWidgetEdgeGaps {
  return {
    right: position.x === "right" ? position.dx : Number.POSITIVE_INFINITY,
    bottom: position.y === "bottom" ? position.dy : Number.POSITIVE_INFINITY,
  };
}

/** The gaps from where the widget really shows once fitted on screen, which can differ from the saved spot after a resize. */
export function onboardingFittedEdgeGaps(placement: OnboardingWidgetPlacement, size: Size, viewport: Size): OnboardingWidgetEdgeGaps {
  return {
    right: placement.right ?? viewport.width - (placement.left ?? 0) - size.width,
    bottom: placement.bottom ?? viewport.height - (placement.top ?? 0) - size.height,
  };
}

/** The support launcher lives in the bottom-right corner; it only steps around a widget that would overlap it. */
export function onboardingSupportDockCorner(gaps: OnboardingWidgetEdgeGaps): "right" | "away" {
  return gaps.right < SUPPORT_LAUNCHER_REACH && gaps.bottom < SUPPORT_LAUNCHER_REACH ? "right" : "away";
}
