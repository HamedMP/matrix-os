import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Circle,
  Download,
  MousePointer2,
  Minus,
  Pen,
  Redo2,
  Square,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "./styles.css";
import {
  addElement,
  boundsOf,
  canRedo,
  canUndo,
  cloneScene,
  commit,
  createHistory,
  deleteElements,
  deserializeScene,
  elementsInRect,
  emptyScene,
  hitTestScene,
  makeId,
  moveElement,
  redo,
  serializeScene,
  undo,
  updateElement,
  type BoxElement,
  type History,
  type LineElement,
  type PenElement,
  type Point,
  type Scene,
  type SceneElement,
  type ToolKind,
} from "./whiteboard-model";

const SCENES_TABLE = "scenes";
const SCENE_NAME = "default";
const LS_KEY = "matrix-whiteboard-scene-v1";
const AUTOSAVE_MS = 800;

const PALETTE = ["#32352E", "#C4342D", "#D06F25", "#3A7D44", "#2D6CDF", "#7A4FD0", "#9A8C66"];
const STROKE_WIDTHS = [2, 4, 8];
const STICKY_FILL = "#FFE9A8";

type SaveState = "idle" | "saving" | "saved" | "error";

interface ToolDef {
  kind: ToolKind;
  label: string;
  shortcut: string;
  icon: typeof MousePointer2;
}

const TOOLS: ToolDef[] = [
  { kind: "select", label: "Select", shortcut: "V", icon: MousePointer2 },
  { kind: "pen", label: "Pen", shortcut: "P", icon: Pen },
  { kind: "rect", label: "Rectangle", shortcut: "R", icon: Square },
  { kind: "ellipse", label: "Ellipse", shortcut: "O", icon: Circle },
  { kind: "arrow", label: "Arrow", shortcut: "A", icon: ArrowUpRight },
  { kind: "line", label: "Line", shortcut: "L", icon: Minus },
  { kind: "text", label: "Text", shortcut: "T", icon: Type },
  { kind: "sticky", label: "Sticky note", shortcut: "N", icon: StickyNote },
];

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface DragState {
  mode: "draw" | "move" | "marquee" | "pan";
  startScene: Point;
  lastScene: Point;
  startScreen: Point;
  startViewport: Viewport;
  draftId?: string;
  movedIds?: string[];
  baseScene?: Scene;
}

function reduceMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

// ---- persistence helpers --------------------------------------------------

function loadLocal(): Scene | null {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return deserializeScene(raw);
  } catch (err: unknown) {
    console.warn("[whiteboard] localStorage read failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function saveLocal(scene: Scene): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(serializeScene(scene)));
  } catch (err: unknown) {
    console.warn("[whiteboard] localStorage write failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---- main component -------------------------------------------------------

export default function App() {
  const [tool, setTool] = useState<ToolKind>("select");
  const [color, setColor] = useState(PALETTE[0]);
  const [strokeWidth, setStrokeWidth] = useState(STROKE_WIDTHS[0]);
  const [history, setHistory] = useState<History>(() => createHistory(emptyScene()));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SceneElement | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<SceneElement | null>(null);
  const sceneRowIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);

  const scene = history.present;
  const elements = scene.elements;

  // Keep draft in a ref so synchronous pointer handlers (down→move→up in one
  // event batch) see the latest value without waiting for a re-render.
  const updateDraft = useCallback((next: SceneElement | null | ((c: SceneElement | null) => SceneElement | null)) => {
    setDraft((curr) => {
      const value = typeof next === "function" ? next(draftRef.current ?? curr) : next;
      draftRef.current = value;
      return value;
    });
  }, []);

  // -- load on mount --------------------------------------------------------
  const reload = useCallback(async () => {
    const db = window.MatrixOS?.db;
    if (!db) {
      const local = loadLocal();
      if (local && local.elements.length > 0) setHistory(createHistory(local));
      return;
    }
    try {
      setError(null);
      const rows = await db.find(SCENES_TABLE, { where: { name: SCENE_NAME }, limit: 1 });
      const row = rows[0];
      if (row && typeof row.id === "string") {
        sceneRowIdRef.current = row.id;
        const next = deserializeScene(row.doc);
        if (!dirtyRef.current) setHistory(createHistory(next));
      }
    } catch (err: unknown) {
      console.warn("[whiteboard] scene load failed:", err instanceof Error ? err.message : String(err));
      setError("Could not load your board.");
    }
  }, []);

  useEffect(() => {
    void reload();
    const db = window.MatrixOS?.db;
    const unsubscribe = db?.onChange?.(SCENES_TABLE, () => {
      if (!dirtyRef.current) void reload();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [reload]);

  // -- debounced autosave ---------------------------------------------------
  const persist = useCallback(async (toSave: Scene) => {
    const db = window.MatrixOS?.db;
    const doc = serializeScene(toSave);
    if (!db) {
      saveLocal(toSave);
      setSaveState("saved");
      return;
    }
    setSaveState("saving");
    try {
      if (sceneRowIdRef.current) {
        await db.update(SCENES_TABLE, sceneRowIdRef.current, { doc });
      } else {
        const res = await db.insert(SCENES_TABLE, { name: SCENE_NAME, doc });
        if (res && typeof res.id === "string") sceneRowIdRef.current = res.id;
      }
      setSaveState("saved");
      setError(null);
    } catch (err: unknown) {
      console.warn("[whiteboard] scene save failed:", err instanceof Error ? err.message : String(err));
      setSaveState("error");
      setError("Changes could not be saved.");
      saveLocal(toSave);
    }
  }, []);

  const scheduleSave = useCallback(
    (toSave: Scene) => {
      dirtyRef.current = true;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void persist(toSave);
      }, AUTOSAVE_MS);
    },
    [persist],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  // -- commit + autosave wrapper -------------------------------------------
  const apply = useCallback(
    (next: Scene) => {
      setHistory((h) => commit(h, next));
      scheduleSave(next);
    },
    [scheduleSave],
  );

  // -- coordinate transform -------------------------------------------------
  const toScene = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = svgRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      return {
        x: (clientX - left - viewport.x) / viewport.zoom,
        y: (clientY - top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  // -- new-element factory --------------------------------------------------
  const makeElementAt = useCallback(
    (kind: ToolKind, p: Point): SceneElement => {
      const id = makeId();
      const base = { id, stroke: color, strokeWidth };
      if (kind === "pen") {
        return { ...base, kind: "pen", fill: "transparent", points: [{ ...p }] } as PenElement;
      }
      if (kind === "line" || kind === "arrow") {
        return { ...base, kind, fill: "transparent", x1: p.x, y1: p.y, x2: p.x, y2: p.y } as LineElement;
      }
      if (kind === "sticky") {
        return { ...base, kind: "sticky", fill: STICKY_FILL, x: p.x, y: p.y, width: 0, height: 0, text: "" } as BoxElement;
      }
      if (kind === "text") {
        return { ...base, kind: "text", fill: "transparent", x: p.x, y: p.y, width: 0, height: 0, text: "" } as BoxElement;
      }
      return { ...base, kind: kind as "rect" | "ellipse", fill: "transparent", x: p.x, y: p.y, width: 0, height: 0 } as BoxElement;
    },
    [color, strokeWidth],
  );

  // -- pointer handling -----------------------------------------------------
  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button === 1 || (e.button === 0 && tool === "select" && e.altKey)) {
        dragRef.current = {
          mode: "pan",
          startScene: { x: 0, y: 0 },
          lastScene: { x: 0, y: 0 },
          startScreen: { x: e.clientX, y: e.clientY },
          startViewport: { ...viewport },
        };
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const p = toScene(e.clientX, e.clientY);
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);

      if (tool === "select") {
        const hit = hitTestScene(scene, p.x, p.y, 6 / viewport.zoom);
        if (hit) {
          const nextSel = new Set(selected);
          if (e.shiftKey) {
            if (nextSel.has(hit.id)) nextSel.delete(hit.id);
            else nextSel.add(hit.id);
          } else if (!nextSel.has(hit.id)) {
            nextSel.clear();
            nextSel.add(hit.id);
          }
          setSelected(nextSel);
          dragRef.current = {
            mode: "move",
            startScene: p,
            lastScene: p,
            startScreen: { x: e.clientX, y: e.clientY },
            startViewport: { ...viewport },
            movedIds: Array.from(nextSel),
            baseScene: cloneScene(scene),
          };
        } else {
          if (!e.shiftKey) setSelected(new Set());
          dragRef.current = {
            mode: "marquee",
            startScene: p,
            lastScene: p,
            startScreen: { x: e.clientX, y: e.clientY },
            startViewport: { ...viewport },
          };
          setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
        }
        return;
      }

      const el = makeElementAt(tool, p);
      updateDraft(el);
      dragRef.current = {
        mode: "draw",
        startScene: p,
        lastScene: p,
        startScreen: { x: e.clientX, y: e.clientY },
        startViewport: { ...viewport },
        draftId: el.id,
      };
    },
    [makeElementAt, scene, selected, tool, toScene, viewport],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === "pan") {
        const dx = e.clientX - drag.startScreen.x;
        const dy = e.clientY - drag.startScreen.y;
        setViewport({ ...drag.startViewport, x: drag.startViewport.x + dx, y: drag.startViewport.y + dy });
        return;
      }
      const p = toScene(e.clientX, e.clientY);

      if (drag.mode === "draw") {
        updateDraft((curr) => {
          if (!curr) return curr;
          if (curr.kind === "pen") {
            return { ...curr, points: [...curr.points, { ...p }] };
          }
          if (curr.kind === "line" || curr.kind === "arrow") {
            return { ...curr, x2: p.x, y2: p.y };
          }
          const b = curr as BoxElement;
          return { ...b, width: p.x - drag.startScene.x, height: p.y - drag.startScene.y };
        });
        return;
      }

      if (drag.mode === "move" && drag.movedIds && drag.baseScene) {
        const dx = p.x - drag.startScene.x;
        const dy = p.y - drag.startScene.y;
        let next = drag.baseScene;
        for (const id of drag.movedIds) next = moveElement(next, id, dx, dy);
        setHistory((h) => ({ ...h, present: next }));
        drag.lastScene = p;
        return;
      }

      if (drag.mode === "marquee") {
        drag.lastScene = p;
        setMarquee({
          x: drag.startScene.x,
          y: drag.startScene.y,
          w: p.x - drag.startScene.x,
          h: p.y - drag.startScene.y,
        });
      }
    },
    [toScene, updateDraft],
  );

  const finishDraft = useCallback(
    (el: SceneElement) => {
      let final = el;
      if (el.kind === "rect" || el.kind === "ellipse" || el.kind === "sticky" || el.kind === "text") {
        const b = el as BoxElement;
        let { x, y, width, height } = b;
        if (Math.abs(width) < 4 && Math.abs(height) < 4) {
          if (el.kind === "sticky") {
            width = 160;
            height = 160;
          } else if (el.kind === "text") {
            width = 160;
            height = 40;
          } else {
            width = 120;
            height = 90;
          }
        }
        if (width < 0) {
          x += width;
          width = -width;
        }
        if (height < 0) {
          y += height;
          height = -height;
        }
        final = { ...b, x, y, width, height };
      }
      apply(addElement(scene, final));
      if (final.kind === "text" || final.kind === "sticky") {
        setEditing({ id: final.id, value: (final as BoxElement).text ?? "" });
      }
      if (tool !== "pen") setTool("select");
    },
    [apply, scene, tool],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      if (!drag) return;

      const currentDraft = draftRef.current;
      if (drag.mode === "draw" && currentDraft) {
        finishDraft(currentDraft);
        updateDraft(null);
        return;
      }
      if (drag.mode === "move") {
        setHistory((h) => {
          if (drag.baseScene && h.present !== drag.baseScene) {
            const moved = h.present;
            scheduleSave(moved);
            return commit({ ...h, present: drag.baseScene }, moved);
          }
          return h;
        });
        return;
      }
      if (drag.mode === "marquee") {
        const mx = drag.startScene.x;
        const my = drag.startScene.y;
        const mw = drag.lastScene.x - drag.startScene.x;
        const mh = drag.lastScene.y - drag.startScene.y;
        const found = elementsInRect(scene, mx, my, mw, mh);
        setSelected((prev) => {
          const next = new Set(e.shiftKey ? prev : []);
          for (const el of found) next.add(el.id);
          return next;
        });
        setMarquee(null);
      }
    },
    [finishDraft, scene, scheduleSave, updateDraft],
  );

  // -- selection ops --------------------------------------------------------
  const deleteSelected = useCallback(() => {
    if (selected.size === 0) return;
    apply(deleteElements(scene, selected));
    setSelected(new Set());
  }, [apply, scene, selected]);

  const doUndo = useCallback(() => {
    setHistory((h) => {
      if (!canUndo(h)) return h;
      const next = undo(h);
      scheduleSave(next.present);
      return next;
    });
    setSelected(new Set());
  }, [scheduleSave]);

  const doRedo = useCallback(() => {
    setHistory((h) => {
      if (!canRedo(h)) return h;
      const next = redo(h);
      scheduleSave(next.present);
      return next;
    });
    setSelected(new Set());
  }, [scheduleSave]);

  const clearBoard = useCallback(() => {
    apply(emptyScene());
    setSelected(new Set());
    setConfirmClear(false);
  }, [apply]);

  const commitEditing = useCallback(() => {
    if (!editing) return;
    apply(updateElement(scene, editing.id, { text: editing.value } as Partial<BoxElement>));
    setEditing(null);
  }, [apply, editing, scene]);

  // -- keyboard shortcuts ---------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        doRedo();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selected.size > 0) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (e.key === "Escape") {
        setSelected(new Set());
        setEditing(null);
        setConfirmClear(false);
        return;
      }
      const match = TOOLS.find((t) => t.shortcut.toLowerCase() === e.key.toLowerCase());
      if (match) setTool(match.kind);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteSelected, doRedo, doUndo, selected]);

  // -- zoom -----------------------------------------------------------------
  const zoomBy = useCallback((factor: number) => {
    setViewport((v) => ({ ...v, zoom: Math.max(0.2, Math.min(4, v.zoom * factor)) }));
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    const cx = e.clientX - (rect?.left ?? 0);
    const cy = e.clientY - (rect?.top ?? 0);
    setViewport((v) => {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const zoom = Math.max(0.2, Math.min(4, v.zoom * factor));
      const sx = (cx - v.x) / v.zoom;
      const sy = (cy - v.y) / v.zoom;
      return { x: cx - sx * zoom, y: cy - sy * zoom, zoom };
    });
  }, []);

  // -- PNG export -----------------------------------------------------------
  const exportPng = useCallback(() => {
    const all = scene.elements;
    const canvas = document.createElement("canvas");
    const padding = 40;
    let minX = 0;
    let minY = 0;
    let maxX = 800;
    let maxY = 600;
    if (all.length > 0) {
      minX = Infinity;
      minY = Infinity;
      maxX = -Infinity;
      maxY = -Infinity;
      for (const el of all) {
        const b = boundsOf(el);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }
    }
    const width = Math.max(1, maxX - minX + padding * 2);
    const height = Math.max(1, maxY - minY + padding * 2);
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Export is not supported here.");
      return;
    }
    const styles = getComputedStyle(document.documentElement);
    ctx.fillStyle = (styles.getPropertyValue("--app-bg") || "#FAFAF5").trim() || "#FAFAF5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(padding - minX, padding - minY);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const el of all) drawToCanvas(ctx, el);
    try {
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `whiteboard-${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err: unknown) {
      console.warn("[whiteboard] PNG export failed:", err instanceof Error ? err.message : String(err));
      setError("Could not export the board.");
    }
  }, [scene]);

  // -- render ---------------------------------------------------------------
  const renderElements = useMemo(() => {
    const list = draft ? [...elements, draft] : elements;
    return list.map((el) => (
      <ElementView key={el.id} el={el} selected={selected.has(el.id)} editing={editing?.id === el.id} />
    ));
  }, [draft, editing, elements, selected]);

  const motion = reduceMotion();
  const gridUnit = 24 * viewport.zoom;

  return (
    <div className={`wb-app${motion ? " wb-app--reduced" : ""}`}>
      <Toolbar
        tool={tool}
        setTool={setTool}
        color={color}
        setColor={setColor}
        strokeWidth={strokeWidth}
        setStrokeWidth={setStrokeWidth}
        canUndo={canUndo(history)}
        canRedo={canRedo(history)}
        onUndo={doUndo}
        onRedo={doRedo}
        onDelete={deleteSelected}
        hasSelection={selected.size > 0}
        onExport={exportPng}
        onClear={() => setConfirmClear(true)}
        saveState={saveState}
      />

      <div className="wb-stage">
        <svg
          ref={svgRef}
          className="wb-canvas"
          data-testid="whiteboard-canvas"
          role="application"
          aria-label="Whiteboard canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
        >
          <defs>
            <pattern
              id="wb-grid"
              width={gridUnit || 24}
              height={gridUnit || 24}
              patternUnits="userSpaceOnUse"
              patternTransform={`translate(${viewport.x % (gridUnit || 24)} ${viewport.y % (gridUnit || 24)})`}
            >
              <circle cx="1" cy="1" r="1" className="wb-grid-dot" />
            </pattern>
            <marker id="wb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          <rect className="wb-grid-bg" x="0" y="0" width="100%" height="100%" fill="url(#wb-grid)" />
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
            {renderElements}
            {selected.size > 0 &&
              elements
                .filter((el) => selected.has(el.id))
                .map((el) => {
                  const b = boundsOf(el);
                  return (
                    <rect key={`sel-${el.id}`} className="wb-selbox" x={b.x - 4} y={b.y - 4} width={b.width + 8} height={b.height + 8} />
                  );
                })}
            {marquee && (
              <rect
                className="wb-marquee"
                x={Math.min(marquee.x, marquee.x + marquee.w)}
                y={Math.min(marquee.y, marquee.y + marquee.h)}
                width={Math.abs(marquee.w)}
                height={Math.abs(marquee.h)}
              />
            )}
          </g>
        </svg>

        {elements.length === 0 && !draft && (
          <div className="wb-empty" data-testid="whiteboard-empty">
            <div className="wb-empty__mark" aria-hidden="true">
              <Pen size={26} />
            </div>
            <h2>Your canvas is empty</h2>
            <p>Pick a tool and start sketching. Try the pen, drop a sticky note, or draw a shape.</p>
            <button type="button" className="wb-empty__cta" onClick={() => setTool("pen")}>
              <Pen size={16} /> Start drawing
            </button>
          </div>
        )}

        {editing && (
          <TextEditorOverlay
            editing={editing}
            element={elements.find((el) => el.id === editing.id) as BoxElement | undefined}
            viewport={viewport}
            onChange={(value) => setEditing({ ...editing, value })}
            onCommit={commitEditing}
            onCancel={() => setEditing(null)}
          />
        )}

        <div className="wb-zoom">
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.9)}>
            <ZoomOut size={16} />
          </button>
          <button type="button" className="wb-zoom__level" onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })} title="Reset zoom">
            {Math.round(viewport.zoom * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.1)}>
            <ZoomIn size={16} />
          </button>
        </div>

        {error && (
          <div className="wb-toast wb-toast--error" role="alert">
            {error}
          </div>
        )}
      </div>

      {confirmClear && (
        <div className="wb-modal" role="dialog" aria-modal="true" aria-label="Clear board">
          <div className="wb-modal__card">
            <h3>Clear the whole board?</h3>
            <p>This removes every element. You can undo right after.</p>
            <div className="wb-modal__actions">
              <button type="button" className="wb-btn-ghost" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
              <button type="button" className="wb-btn-danger" onClick={clearBoard}>
                Clear board
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

interface ToolbarProps {
  tool: ToolKind;
  setTool: (t: ToolKind) => void;
  color: string;
  setColor: (c: string) => void;
  strokeWidth: number;
  setStrokeWidth: (w: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  hasSelection: boolean;
  onExport: () => void;
  onClear: () => void;
  saveState: SaveState;
}

function Toolbar(props: ToolbarProps) {
  const {
    tool, setTool, color, setColor, strokeWidth, setStrokeWidth,
    canUndo: canU, canRedo: canR, onUndo, onRedo, onDelete, hasSelection, onExport, onClear, saveState,
  } = props;
  return (
    <header className="wb-toolbar">
      <div className="wb-toolgroup" role="toolbar" aria-label="Tools">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          const active = tool === t.kind;
          return (
            <button
              key={t.kind}
              type="button"
              className={active ? "wb-tool wb-tool--active" : "wb-tool"}
              aria-label={`${t.label} (${t.shortcut})`}
              aria-pressed={active}
              title={`${t.label} — ${t.shortcut}`}
              onClick={() => setTool(t.kind)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>

      <div className="wb-divider" aria-hidden="true" />

      <div className="wb-palette" role="group" aria-label="Color">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={c === color ? "wb-swatch wb-swatch--active" : "wb-swatch"}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            aria-pressed={c === color}
            onClick={() => setColor(c)}
          />
        ))}
      </div>

      <div className="wb-strokes" role="group" aria-label="Stroke width">
        {STROKE_WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            className={w === strokeWidth ? "wb-stroke wb-stroke--active" : "wb-stroke"}
            aria-label={`Stroke ${w} pixels`}
            aria-pressed={w === strokeWidth}
            onClick={() => setStrokeWidth(w)}
          >
            <span style={{ height: w }} />
          </button>
        ))}
      </div>

      <div className="wb-divider" aria-hidden="true" />

      <div className="wb-toolgroup">
        <button type="button" className="wb-tool" aria-label="Undo" title="Undo — Cmd/Ctrl+Z" disabled={!canU} onClick={onUndo}>
          <Undo2 size={18} />
        </button>
        <button type="button" className="wb-tool" aria-label="Redo" title="Redo — Cmd/Ctrl+Y" disabled={!canR} onClick={onRedo}>
          <Redo2 size={18} />
        </button>
        <button type="button" className="wb-tool" aria-label="Delete selection" title="Delete — Del" disabled={!hasSelection} onClick={onDelete}>
          <Trash2 size={18} />
        </button>
      </div>

      <div className="wb-toolbar__spacer" />

      <div className="wb-save" aria-live="polite">
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved"}
        {saveState === "error" && "Save failed"}
      </div>

      <div className="wb-toolgroup">
        <button type="button" className="wb-action" onClick={onExport} title="Export PNG">
          <Download size={16} /> <span>PNG</span>
        </button>
        <button type="button" className="wb-action wb-action--ghost" onClick={onClear} title="Clear board">
          Clear
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Element rendering
// ---------------------------------------------------------------------------

function penPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 0.1} ${p.y + 0.1}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const mx = (prev.x + curr.x) / 2;
    const my = (prev.y + curr.y) / 2;
    d += ` Q ${prev.x} ${prev.y} ${mx} ${my}`;
  }
  return d;
}

function ElementView({ el, selected, editing }: { el: SceneElement; selected: boolean; editing: boolean }) {
  const className = selected ? "wb-el wb-el--selected" : "wb-el";
  if (el.kind === "pen") {
    return (
      <path
        d={penPath((el as PenElement).points)}
        fill="none"
        stroke={el.stroke}
        strokeWidth={el.strokeWidth}
        className={className}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (el.kind === "line" || el.kind === "arrow") {
    const l = el as LineElement;
    return (
      <line
        x1={l.x1}
        y1={l.y1}
        x2={l.x2}
        y2={l.y2}
        stroke={l.stroke}
        strokeWidth={l.strokeWidth}
        strokeLinecap="round"
        className={className}
        markerEnd={el.kind === "arrow" ? "url(#wb-arrow)" : undefined}
      />
    );
  }
  const b = el as BoxElement;
  const x = b.width < 0 ? b.x + b.width : b.x;
  const y = b.height < 0 ? b.y + b.height : b.y;
  const w = Math.abs(b.width);
  const h = Math.abs(b.height);
  const stroke = el.stroke;
  const fill = el.fill === "transparent" ? "none" : el.fill;
  if (el.kind === "ellipse") {
    return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} stroke={stroke} strokeWidth={el.strokeWidth} fill={fill} className={className} />;
  }
  if (el.kind === "sticky") {
    return (
      <g className={className}>
        <rect x={x} y={y} width={w} height={h} rx={6} fill={b.fill} stroke="rgba(50,53,46,0.14)" strokeWidth={1} className="wb-sticky" />
        {!editing && b.text ? (
          <foreignObject x={x} y={y} width={w} height={h}>
            <div className="wb-sticky-text">{b.text}</div>
          </foreignObject>
        ) : null}
      </g>
    );
  }
  if (el.kind === "text") {
    if (editing) return null;
    return (
      <foreignObject x={x} y={y} width={Math.max(w, 40)} height={Math.max(h, 24)} className={className}>
        <div className="wb-text" style={{ color: el.stroke, fontSize: 18 + el.strokeWidth * 2 }}>
          {b.text || ""}
        </div>
      </foreignObject>
    );
  }
  return <rect x={x} y={y} width={w} height={h} rx={8} stroke={stroke} strokeWidth={el.strokeWidth} fill={fill} className={className} />;
}

// ---------------------------------------------------------------------------
// Text editing overlay
// ---------------------------------------------------------------------------

function TextEditorOverlay({
  editing,
  element,
  viewport,
  onChange,
  onCommit,
  onCancel,
}: {
  editing: { id: string; value: string };
  element: BoxElement | undefined;
  viewport: Viewport;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  if (!element) return null;
  const left = element.x * viewport.zoom + viewport.x;
  const top = element.y * viewport.zoom + viewport.y;
  const width = Math.max(Math.abs(element.width) * viewport.zoom, 120);
  const height = Math.max(Math.abs(element.height) * viewport.zoom, 36);
  return (
    <textarea
      ref={ref}
      className="wb-text-editor"
      value={editing.value}
      style={{ left, top, width, height }}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit();
        }
      }}
      placeholder="Type…"
    />
  );
}

// ---------------------------------------------------------------------------
// Canvas drawing for PNG export
// ---------------------------------------------------------------------------

function drawToCanvas(ctx: CanvasRenderingContext2D, el: SceneElement): void {
  ctx.strokeStyle = el.stroke;
  ctx.lineWidth = el.strokeWidth;
  if (el.kind === "pen") {
    const pen = el as PenElement;
    if (pen.points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(pen.points[0].x, pen.points[0].y);
    for (let i = 1; i < pen.points.length; i += 1) ctx.lineTo(pen.points[i].x, pen.points[i].y);
    ctx.stroke();
    return;
  }
  if (el.kind === "line" || el.kind === "arrow") {
    const l = el as LineElement;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
    if (el.kind === "arrow") {
      const angle = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
      const size = 8 + el.strokeWidth;
      ctx.beginPath();
      ctx.moveTo(l.x2, l.y2);
      ctx.lineTo(l.x2 - size * Math.cos(angle - Math.PI / 6), l.y2 - size * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(l.x2, l.y2);
      ctx.lineTo(l.x2 - size * Math.cos(angle + Math.PI / 6), l.y2 - size * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
    return;
  }
  const b = el as BoxElement;
  const x = b.width < 0 ? b.x + b.width : b.x;
  const y = b.height < 0 ? b.y + b.height : b.y;
  const w = Math.abs(b.width);
  const h = Math.abs(b.height);
  if (el.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (el.kind === "sticky") {
    ctx.fillStyle = b.fill;
    ctx.fillRect(x, y, w, h);
    if (b.text) {
      ctx.fillStyle = "#32352E";
      ctx.font = "16px Inter, system-ui, sans-serif";
      wrapText(ctx, b.text, x + 10, y + 24, w - 20, 20);
    }
    return;
  }
  if (el.kind === "text") {
    if (b.text) {
      ctx.fillStyle = el.stroke;
      ctx.font = `${18 + el.strokeWidth * 2}px Inter, system-ui, sans-serif`;
      wrapText(ctx, b.text, x, y + 20, Math.max(w, 120), 22);
    }
    return;
  }
  ctx.strokeRect(x, y, w, h);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const words = text.split(/\s+/);
  let line = "";
  let cursorY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}
