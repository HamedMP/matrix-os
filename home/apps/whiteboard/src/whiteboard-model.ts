// Pure, UI-free scene model for the whiteboard app.
// Element types, CRUD, hit-testing, history (undo/redo), serialize/deserialize.

export type ToolKind =
  | "select"
  | "pen"
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "text"
  | "sticky";

export type ElementKind =
  | "pen"
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "text"
  | "sticky";

export interface Point {
  x: number;
  y: number;
}

export interface BaseElement {
  id: string;
  kind: ElementKind;
  stroke: string;
  fill: string;
  strokeWidth: number;
}

export interface BoxElement extends BaseElement {
  kind: "rect" | "ellipse" | "text" | "sticky";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

export interface LineElement extends BaseElement {
  kind: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PenElement extends BaseElement {
  kind: "pen";
  points: Point[];
}

export type SceneElement = BoxElement | LineElement | PenElement;

export interface Scene {
  elements: SceneElement[];
}

export interface SerializedScene {
  version: 1;
  elements: SceneElement[];
}

export const SCENE_VERSION = 1 as const;

let idCounter = 0;

/** Deterministic-ish id generator that still avoids collisions across a session. */
export function makeId(): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `el-${Date.now().toString(36)}-${idCounter}-${rand}`;
}

export function emptyScene(): Scene {
  return { elements: [] };
}

export function cloneScene(scene: Scene): Scene {
  return { elements: scene.elements.map(cloneElement) };
}

export function cloneElement(el: SceneElement): SceneElement {
  if (el.kind === "pen") {
    return { ...el, points: el.points.map((p) => ({ ...p })) };
  }
  return { ...el };
}

/** Immutably add an element, returning a new scene. */
export function addElement(scene: Scene, el: SceneElement): Scene {
  return { elements: [...scene.elements, cloneElement(el)] };
}

/** Immutably update an element by id with a partial patch. No-op if missing. */
export function updateElement(
  scene: Scene,
  id: string,
  patch: Partial<SceneElement>,
): Scene {
  return {
    elements: scene.elements.map((el) =>
      el.id === id ? (mergeElement(el, patch) as SceneElement) : el,
    ),
  };
}

function mergeElement(el: SceneElement, patch: Partial<SceneElement>): SceneElement {
  const merged = { ...el, ...patch, id: el.id, kind: el.kind } as SceneElement;
  return cloneElement(merged);
}

/** Immutably move an element by (dx, dy). */
export function moveElement(scene: Scene, id: string, dx: number, dy: number): Scene {
  return {
    elements: scene.elements.map((el) => (el.id === id ? translate(el, dx, dy) : el)),
  };
}

export function translate(el: SceneElement, dx: number, dy: number): SceneElement {
  if (el.kind === "pen") {
    return { ...el, points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
  if (el.kind === "line" || el.kind === "arrow") {
    return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy };
  }
  const box = el as BoxElement;
  return { ...box, x: box.x + dx, y: box.y + dy };
}

/** Immutably remove an element by id. */
export function deleteElement(scene: Scene, id: string): Scene {
  return { elements: scene.elements.filter((el) => el.id !== id) };
}

export function deleteElements(scene: Scene, ids: Iterable<string>): Scene {
  const set = new Set(ids);
  return { elements: scene.elements.filter((el) => !set.has(el.id)) };
}

/** Axis-aligned bounding box for any element. */
export function boundsOf(el: SceneElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (el.kind === "pen") {
    if (el.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of el.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  if (el.kind === "line" || el.kind === "arrow") {
    const x = Math.min(el.x1, el.x2);
    const y = Math.min(el.y1, el.y2);
    return { x, y, width: Math.abs(el.x2 - el.x1), height: Math.abs(el.y2 - el.y1) };
  }
  const box = el as BoxElement;
  const x = Math.min(box.x, box.x + box.width);
  const y = Math.min(box.y, box.y + box.height);
  return { x, y, width: Math.abs(box.width), height: Math.abs(box.height) };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * Does the point (x, y) hit the element? `tolerance` widens line/stroke hits.
 * Boxes are hit anywhere inside (plus tolerance); lines/pen near the stroke.
 */
export function hitTest(el: SceneElement, x: number, y: number, tolerance = 6): boolean {
  const p = { x, y };
  if (el.kind === "line" || el.kind === "arrow") {
    return (
      distanceToSegment(p, { x: el.x1, y: el.y1 }, { x: el.x2, y: el.y2 }) <=
      tolerance + el.strokeWidth / 2
    );
  }
  if (el.kind === "pen") {
    for (let i = 1; i < el.points.length; i += 1) {
      if (
        distanceToSegment(p, el.points[i - 1], el.points[i]) <=
        tolerance + el.strokeWidth / 2
      ) {
        return true;
      }
    }
    // single dot
    if (el.points.length === 1) {
      return Math.hypot(x - el.points[0].x, y - el.points[0].y) <= tolerance + el.strokeWidth;
    }
    return false;
  }
  const b = boundsOf(el);
  if (el.kind === "ellipse") {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const rx = b.width / 2 + tolerance;
    const ry = b.height / 2 + tolerance;
    if (rx <= 0 || ry <= 0) return false;
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return (
    x >= b.x - tolerance &&
    x <= b.x + b.width + tolerance &&
    y >= b.y - tolerance &&
    y <= b.y + b.height + tolerance
  );
}

/** Topmost element under the point (last drawn wins), or null. */
export function hitTestScene(scene: Scene, x: number, y: number, tolerance = 6): SceneElement | null {
  for (let i = scene.elements.length - 1; i >= 0; i -= 1) {
    if (hitTest(scene.elements[i], x, y, tolerance)) return scene.elements[i];
  }
  return null;
}

/** All elements whose bounding box intersects the given rectangle (marquee select). */
export function elementsInRect(
  scene: Scene,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): SceneElement[] {
  const x0 = Math.min(rx, rx + rw);
  const y0 = Math.min(ry, ry + rh);
  const x1 = Math.max(rx, rx + rw);
  const y1 = Math.max(ry, ry + rh);
  return scene.elements.filter((el) => {
    const b = boundsOf(el);
    return b.x <= x1 && b.x + b.width >= x0 && b.y <= y1 && b.y + b.height >= y0;
  });
}

// ---------------------------------------------------------------------------
// History (undo / redo)
// ---------------------------------------------------------------------------

export interface History {
  past: Scene[];
  present: Scene;
  future: Scene[];
  limit: number;
}

const DEFAULT_HISTORY_LIMIT = 100;

export function createHistory(initial: Scene = emptyScene(), limit = DEFAULT_HISTORY_LIMIT): History {
  return { past: [], present: cloneScene(initial), future: [], limit };
}

/** Push a new present scene; clears the redo stack and caps the undo stack. */
export function commit(history: History, next: Scene): History {
  const past = [...history.past, history.present];
  while (past.length > history.limit) past.shift();
  return { past, present: cloneScene(next), future: [], limit: history.limit };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

export function undo(history: History): History {
  if (!canUndo(history)) return history;
  const past = [...history.past];
  const previous = past.pop() as Scene;
  return {
    past,
    present: previous,
    future: [history.present, ...history.future],
    limit: history.limit,
  };
}

export function redo(history: History): History {
  if (!canRedo(history)) return history;
  const [next, ...rest] = history.future;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    limit: history.limit,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeScene(scene: Scene): SerializedScene {
  return { version: SCENE_VERSION, elements: scene.elements.map(cloneElement) };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function coerceElement(raw: unknown): SceneElement | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const kind = data.kind;
  const id = typeof data.id === "string" ? data.id : makeId();
  const stroke = typeof data.stroke === "string" ? data.stroke : "#32352E";
  const fill = typeof data.fill === "string" ? data.fill : "transparent";
  const strokeWidth = isFiniteNumber(data.strokeWidth) ? data.strokeWidth : 2;
  const base = { id, stroke, fill, strokeWidth };

  if (kind === "pen") {
    const points = Array.isArray(data.points)
      ? data.points
          .map((p) =>
            p && typeof p === "object" && isFiniteNumber((p as Point).x) && isFiniteNumber((p as Point).y)
              ? { x: (p as Point).x, y: (p as Point).y }
              : null,
          )
          .filter((p): p is Point => p !== null)
      : [];
    return { ...base, kind: "pen", points };
  }
  if (kind === "line" || kind === "arrow") {
    if (
      !isFiniteNumber(data.x1) ||
      !isFiniteNumber(data.y1) ||
      !isFiniteNumber(data.x2) ||
      !isFiniteNumber(data.y2)
    ) {
      return null;
    }
    return { ...base, kind, x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2 };
  }
  if (kind === "rect" || kind === "ellipse" || kind === "text" || kind === "sticky") {
    if (
      !isFiniteNumber(data.x) ||
      !isFiniteNumber(data.y) ||
      !isFiniteNumber(data.width) ||
      !isFiniteNumber(data.height)
    ) {
      return null;
    }
    const text = typeof data.text === "string" ? data.text : undefined;
    return { ...base, kind, x: data.x, y: data.y, width: data.width, height: data.height, text };
  }
  return null;
}

/** Parse a serialized scene from an unknown value (JSON object or string). */
export function deserializeScene(raw: unknown): Scene {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (err: unknown) {
      console.warn(
        "[whiteboard] failed to parse scene JSON:",
        err instanceof Error ? err.message : String(err),
      );
      return emptyScene();
    }
  }
  if (!value || typeof value !== "object") return emptyScene();
  const data = value as Record<string, unknown>;
  const list = Array.isArray(data.elements) ? data.elements : [];
  const elements = list
    .map(coerceElement)
    .filter((el): el is SceneElement => el !== null);
  return { elements };
}
