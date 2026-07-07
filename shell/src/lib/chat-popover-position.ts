// Drag-position helpers for the bottom-centered chat popover.
//
// The popup is anchored bottom-center via `left:50%` + a keyframe-baked
// `transform: translate(-50%, …)`. Dragging applies an *additional* offset
// through the independent CSS `translate` property (which composes with
// `transform` without disturbing the open/close animations). These helpers
// keep that offset sane: clamped on-screen and persisted across reopen.

export interface ChatPopoverOffset {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

const STORAGE_KEY = "matrix:chat-popover-offset";

export const ZERO_OFFSET: ChatPopoverOffset = { x: 0, y: 0 };

function clampValue(value: number, min: number, max: number): number {
  // Popup larger than the available range (tiny viewport): don't fight the
  // user with a jittery clamp -- snap that axis home instead.
  if (max < min) return 0;
  return Math.min(Math.max(value, min), max);
}

/**
 * Constrain a drag offset so the whole popup stays within `margin`px of every
 * viewport edge. `bottomGap` is the popup's resting distance from the bottom
 * (Tailwind `bottom-5` = 20px).
 */
export function clampOffset(
  offset: ChatPopoverOffset,
  viewport: Size,
  popup: Size,
  bottomGap = 20,
  margin = 24,
): ChatPopoverOffset {
  // Resting top-left of the centered popup, before any drag offset.
  const restLeft = viewport.width / 2 - popup.width / 2;
  const restTop = viewport.height - bottomGap - popup.height;

  const minX = margin - restLeft;
  const maxX = viewport.width - margin - popup.width - restLeft;
  const minY = margin - restTop;
  const maxY = viewport.height - margin - popup.height - restTop;

  return {
    x: clampValue(offset.x, minX, maxX),
    y: clampValue(offset.y, minY, maxY),
  };
}

export function loadOffset(): ChatPopoverOffset {
  if (typeof window === "undefined") return { ...ZERO_OFFSET };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...ZERO_OFFSET };
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    const x = typeof parsed.x === "number" && Number.isFinite(parsed.x) ? parsed.x : 0;
    const y = typeof parsed.y === "number" && Number.isFinite(parsed.y) ? parsed.y : 0;
    return { x, y };
  } catch (err: unknown) {
    console.warn(
      "[chat] Failed to load popover offset:",
      err instanceof Error ? err.message : String(err),
    );
    return { ...ZERO_OFFSET };
  }
}

export function saveOffset(offset: ChatPopoverOffset): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
  } catch (err: unknown) {
    console.warn(
      "[chat] Failed to save popover offset:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function isDragged(offset: ChatPopoverOffset): boolean {
  return offset.x !== 0 || offset.y !== 0;
}
