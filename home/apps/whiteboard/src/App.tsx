import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Check,
  Circle,
  Download,
  FilePlus2,
  MousePointer2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Pen,
  Pencil,
  Redo2,
  Square,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "./styles.css";
import {
  addElement,
  boardIndexFromRows,
  boundsOf,
  canRedo,
  canUndo,
  cloneScene,
  commit,
  createHistory,
  deleteElements,
  deserializeScene,
  docFromRow,
  elementsInRect,
  emptyScene,
  hitTestScene,
  makeId,
  moveElement,
  normalizeBoardName,
  redo,
  serializeScene,
  undo,
  updateElement,
  type BoardMeta,
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
const LS_KEY = "matrix-whiteboard-scene-v1";
const LS_NAME_KEY = "matrix-whiteboard-name-v1";
const AUTOSAVE_MS = 800;
const BOARD_LIST_ERROR = "Could not load your boards.";

const PALETTE = ["#32352E", "#C4342D", "#D06F25", "#3A7D44", "#2D6CDF", "#7A4FD0", "#9A8C66"];
const STROKE_WIDTHS = [2, 4, 8];
const STICKY_FILL = "#FFE9A8";

type SaveState = "idle" | "saving" | "saved" | "error";

const MODAL_FOCUS_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

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

interface BoardIndexResult {
  boards: BoardMeta[];
  ok: boolean;
}

function reduceMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

function ModalDialog({ label, children }: { label: string; children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const first = cardRef.current?.querySelector<HTMLElement>(MODAL_FOCUS_SELECTOR);
    first?.focus();
  }, []);

  return (
    <div className="wb-modal" role="dialog" aria-modal="true" aria-label={label}>
      <div
        ref={cardRef}
        className="wb-modal__card"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const card = cardRef.current;
          if (!card) return;
          const focusable = Array.from(card.querySelectorAll<HTMLElement>(MODAL_FOCUS_SELECTOR)).filter(
            (element) => element.tabIndex !== -1,
          );
          if (focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const active = document.activeElement;
          const activeIndex = focusable.findIndex((element) => element === active);
          event.preventDefault();
          if (event.shiftKey) {
            const previousIndex = activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1;
            focusable[previousIndex]?.focus();
            return;
          }
          const nextIndex = activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1;
          focusable[nextIndex]?.focus();
        }}
      >
        {children}
      </div>
    </div>
  );
}

const LOCAL_BOARD_ID = "__local__";

// ---- persistence helpers --------------------------------------------------
// localStorage is a guarded test/no-DB-only fallback. In the sandboxed shell
// it can throw SecurityError, so every access is wrapped. In the shell the
// MatrixOS DB bridge is the canonical transport (see agent-brief §2).

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

function loadLocalName(): string {
  try {
    const raw = window.localStorage.getItem(LS_NAME_KEY);
    return normalizeBoardName(raw);
  } catch (err: unknown) {
    console.warn("[whiteboard] localStorage name read failed:", err instanceof Error ? err.message : String(err));
    return normalizeBoardName(null);
  }
}

function saveLocal(scene: Scene): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(serializeScene(scene)));
  } catch (err: unknown) {
    console.warn("[whiteboard] localStorage write failed:", err instanceof Error ? err.message : String(err));
  }
}

function saveLocalName(name: string): void {
  try {
    window.localStorage.setItem(LS_NAME_KEY, name);
  } catch (err: unknown) {
    console.warn("[whiteboard] localStorage name write failed:", err instanceof Error ? err.message : String(err));
  }
}

function nextUntitledName(boards: readonly BoardMeta[], reservedNames: ReadonlySet<string> = new Set()): string {
  const base = "Untitled board";
  const taken = new Set(boards.map((b) => b.name.toLowerCase()));
  for (const name of reservedNames) taken.add(name.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
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

  // -- multi-board ("files") state -----------------------------------------
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BoardMeta | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const svgIdPrefix = useId().replace(/:/g, "");
  const gridId = `${svgIdPrefix}-wb-grid`;
  const arrowId = `${svgIdPrefix}-wb-arrow`;
  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<SceneElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const historyRef = useRef<History>(history);
  const renameCommitKeyRef = useRef<string | null>(null);
  const pendingBoardNamesRef = useRef<Set<string>>(new Set());
  const editingCommitIdRef = useRef<string | null>(null);

  // Keep a ref of the active board id so debounced/async saves target the
  // board that was active when the edit happened, not a stale closure value.
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const scene = history.present;
  const elements = scene.elements;

  // Keep draft in a ref so synchronous pointer handlers (down→move→up in one
  // event batch) see the latest value without waiting for a re-render. The ref
  // is the source of truth and is updated synchronously; setDraft only drives
  // rendering. (Updating the ref inside the setState updater is unreliable
  // because React may defer the updater past the next pointer event.)
  const updateDraft = useCallback((next: SceneElement | null | ((c: SceneElement | null) => SceneElement | null)) => {
    const value = typeof next === "function" ? next(draftRef.current) : next;
    draftRef.current = value;
    setDraft(value);
  }, []);

  // -- load a single board's doc into the canvas ---------------------------
  const openBoard = useCallback(async (id: string) => {
    const db = window.MatrixOS?.db;
    dirtyRef.current = false;
    setSaveState("idle");
    setActiveId(id);
    activeIdRef.current = id;
    setSelected(new Set());
    setEditing(null);
    setRenaming(null);
    setDraft(null);
    setViewport({ x: 0, y: 0, zoom: 1 });

    if (!db || id === LOCAL_BOARD_ID) {
      const local = loadLocal();
      const nextHistory = createHistory(local ?? emptyScene());
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      setLoadingBoard(false);
      return;
    }
    setLoadingBoard(true);
    try {
      setError(null);
      const rows = await db.find(SCENES_TABLE, { where: { id }, limit: 1 });
      const row = rows[0] ?? null;
      // Ignore the result if the user switched away while we were loading.
      if (activeIdRef.current !== id) return;
      const nextHistory = createHistory(deserializeScene(docFromRow(row)));
      historyRef.current = nextHistory;
      setHistory(nextHistory);
    } catch (err: unknown) {
      console.warn("[whiteboard] board load failed:", err instanceof Error ? err.message : String(err));
      if (activeIdRef.current === id) setError("Could not load that board.");
    } finally {
      if (activeIdRef.current === id) setLoadingBoard(false);
    }
  }, []);

  // -- refresh the board index (sidebar list) -------------------------------
  const refreshIndex = useCallback(async (opts: { reportError?: boolean } = {}): Promise<BoardIndexResult> => {
    const db = window.MatrixOS?.db;
    if (!db) {
      const local: BoardMeta = { id: LOCAL_BOARD_ID, name: loadLocalName(), updatedAt: 0 };
      setBoards([local]);
      return { boards: [local], ok: true };
    }
    try {
      const rows = await db.find(SCENES_TABLE, { orderBy: { created_at: "desc" } });
      const index = boardIndexFromRows(rows);
      setBoards(index);
      setError((prev) => (prev === BOARD_LIST_ERROR ? null : prev));
      return { boards: index, ok: true };
    } catch (err: unknown) {
      console.warn("[whiteboard] board list failed:", err instanceof Error ? err.message : String(err));
      if (opts.reportError !== false) setError(BOARD_LIST_ERROR);
      return { boards: [], ok: false };
    }
  }, []);

  // -- create a board -------------------------------------------------------
  const createBoard = useCallback(
    async (name?: string): Promise<string | null> => {
      const db = window.MatrixOS?.db;
      const isGeneratedName = name == null;
      const boardName = normalizeBoardName(name ?? nextUntitledName(boards, pendingBoardNamesRef.current));
      const reservedName = isGeneratedName ? boardName.toLowerCase() : null;
      if (reservedName) pendingBoardNamesRef.current.add(reservedName);
      const doc = serializeScene(emptyScene());
      try {
        if (!db) {
          // No DB: a single local board only.
          saveLocal(emptyScene());
          saveLocalName(boardName);
          await refreshIndex();
          await openBoard(LOCAL_BOARD_ID);
          return LOCAL_BOARD_ID;
        }
        try {
          setError(null);
          const res = await db.insert(SCENES_TABLE, { name: boardName, doc });
          const id = res && typeof res.id === "string" ? res.id : null;
          await refreshIndex();
          if (!id) {
            console.warn("[whiteboard] create board response did not include an id");
            setError("Could not create a board.");
            setLoadingBoard(false);
            return null;
          }
          await openBoard(id);
          return id;
        } catch (err: unknown) {
          console.warn("[whiteboard] create board failed:", err instanceof Error ? err.message : String(err));
          setError("Could not create a board.");
          setLoadingBoard(false);
          return null;
        }
      } finally {
        if (reservedName) pendingBoardNamesRef.current.delete(reservedName);
      }
    },
    [boards, openBoard, refreshIndex],
  );

  // -- initial load: pick most recent board, or create the first one --------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const index = await refreshIndex();
      if (cancelled) return;
      if (!index.ok) {
        setLoadingBoard(false);
      } else if (index.boards.length > 0) {
        await openBoard(index.boards[0].id);
      } else if (window.MatrixOS?.db) {
        await createBoard("Untitled board");
      } else {
        await openBoard(LOCAL_BOARD_ID);
      }
    })();
    const db = window.MatrixOS?.db;
    const unsubscribe = db?.onChange?.(SCENES_TABLE, () => {
      // Reconcile the list without reopening the active board. The bridge
      // notification is table-wide, so reopening would reset viewport,
      // selection, and in-progress edits for unrelated board writes.
      void refreshIndex({ reportError: false });
    });
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- debounced autosave to the ACTIVE board's row -------------------------
  const persist = useCallback(async (toSave: Scene, boardId: string | null) => {
    const db = window.MatrixOS?.db;
    const doc = serializeScene(toSave);
    if (!db || boardId === LOCAL_BOARD_ID) {
      saveLocal(toSave);
      if (activeIdRef.current === boardId) {
        setSaveState("saved");
        dirtyRef.current = false;
      }
      return;
    }
    if (!boardId) return;
    if (activeIdRef.current === boardId) setSaveState("saving");
    try {
      await db.update(SCENES_TABLE, boardId, { doc });
      if (activeIdRef.current === boardId) {
        setSaveState("saved");
        setError(null);
        dirtyRef.current = false;
      }
      // Bump this board to the top of the recency-sorted list locally.
      setBoards((prev) =>
        [...prev]
          .map((b) => (b.id === boardId ? { ...b, updatedAt: Date.now() } : b))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    } catch (err: unknown) {
      console.warn("[whiteboard] scene save failed:", err instanceof Error ? err.message : String(err));
      if (activeIdRef.current === boardId) {
        setSaveState("error");
        setError("Changes could not be saved.");
      }
      saveLocal(toSave);
    }
  }, []);

  const scheduleSave = useCallback(
    (toSave: Scene, targetBoardId: string | null = activeIdRef.current) => {
      dirtyRef.current = true;
      const boardId = targetBoardId;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void persist(toSave, boardId);
      }, AUTOSAVE_MS);
    },
    [persist],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  // -- switch boards (flush a pending save first) ---------------------------
  const switchBoard = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (dirtyRef.current) void persist(historyRef.current.present, activeIdRef.current);
      }
      void openBoard(id);
    },
    [openBoard, persist],
  );

  // -- rename a board -------------------------------------------------------
  const commitRename = useCallback(async () => {
    const r = renaming;
    if (!r) return;
    const name = normalizeBoardName(r.value);
    const commitKey = `${r.id}:${name}`;
    if (renameCommitKeyRef.current === commitKey) return;
    renameCommitKeyRef.current = commitKey;
    const snapshot = boards;
    setBoards((prev) => prev.map((b) => (b.id === r.id ? { ...b, name } : b)));
    const db = window.MatrixOS?.db;
    if (!db || r.id === LOCAL_BOARD_ID) {
      saveLocalName(name);
      setRenaming(null);
      return;
    }
    try {
      await db.update(SCENES_TABLE, r.id, { name });
      setRenaming(null);
    } catch (err: unknown) {
      console.warn("[whiteboard] rename failed:", err instanceof Error ? err.message : String(err));
      renameCommitKeyRef.current = null;
      setBoards(snapshot);
      setError("Could not rename the board.");
      void refreshIndex().then((result) => {
        setError(result.ok ? null : "Could not rename the board.");
      });
    }
  }, [boards, refreshIndex, renaming]);

  // -- delete a board -------------------------------------------------------
  const deleteBoard = useCallback(
    async (board: BoardMeta) => {
      const db = window.MatrixOS?.db;
      if (!db || board.id === LOCAL_BOARD_ID) {
        saveLocal(emptyScene());
        const nextHistory = createHistory(emptyScene());
        historyRef.current = nextHistory;
        setHistory(nextHistory);
        setConfirmDelete(null);
        return;
      }
      try {
        setError(null);
        await db.delete(SCENES_TABLE, board.id);
        const index = await refreshIndex();
        if (board.id === activeIdRef.current) {
          if (!index.ok) {
            setLoadingBoard(false);
          } else if (index.boards.length > 0) {
            await openBoard(index.boards[0].id);
          } else {
            await createBoard("Untitled board");
          }
        }
        setConfirmDelete(null);
      } catch (err: unknown) {
        console.warn("[whiteboard] delete board failed:", err instanceof Error ? err.message : String(err));
        setError("Could not delete the board.");
      }
    },
    [createBoard, openBoard, refreshIndex],
  );

  // -- commit + autosave wrapper -------------------------------------------
  const apply = useCallback(
    (next: Scene, targetBoardId: string | null = activeIdRef.current) => {
      setHistory((h) => {
        const nextHistory = commit(h, next);
        historyRef.current = nextHistory;
        return nextHistory;
      });
      scheduleSave(next, targetBoardId);
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
        e.preventDefault();
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
        setHistory((h) => {
          const nextHistory = { ...h, present: next };
          historyRef.current = nextHistory;
          return nextHistory;
        });
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
        editingCommitIdRef.current = null;
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
        const current = historyRef.current;
        if (drag.baseScene && current.present !== drag.baseScene) {
          const moved = current.present;
          const nextHistory = commit({ ...current, present: drag.baseScene }, moved);
          historyRef.current = nextHistory;
          setHistory(nextHistory);
          scheduleSave(moved);
        }
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

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      updateDraft(null);
      setMarquee(null);
      if (drag?.mode === "draw" && tool !== "pen") {
        setTool("select");
      }
      if (drag?.mode === "move" && drag.baseScene) {
        setHistory((current) => {
          const nextHistory = { ...current, present: drag.baseScene as Scene };
          historyRef.current = nextHistory;
          return nextHistory;
        });
      }
    },
    [tool, updateDraft],
  );

  // -- selection ops --------------------------------------------------------
  const deleteSelected = useCallback(() => {
    if (selected.size === 0) return;
    apply(deleteElements(scene, selected));
    setSelected(new Set());
  }, [apply, scene, selected]);

  const doUndo = useCallback(() => {
    const current = historyRef.current;
    if (!canUndo(current)) return;
    const next = undo(current);
    historyRef.current = next;
    setHistory(next);
    scheduleSave(next.present);
    setSelected(new Set());
  }, [scheduleSave]);

  const doRedo = useCallback(() => {
    const current = historyRef.current;
    if (!canRedo(current)) return;
    const next = redo(current);
    historyRef.current = next;
    setHistory(next);
    scheduleSave(next.present);
    setSelected(new Set());
  }, [scheduleSave]);

  const clearBoard = useCallback(() => {
    apply(emptyScene());
    setSelected(new Set());
    setConfirmClear(false);
  }, [apply]);

  const commitEditing = useCallback(() => {
    if (!editing) return;
    if (editingCommitIdRef.current === editing.id) return;
    editingCommitIdRef.current = editing.id;
    apply(updateElement(scene, editing.id, { text: editing.value } as Partial<BoxElement>), activeId);
    setEditing(null);
  }, [activeId, apply, editing, scene]);

  useEffect(() => {
    if (!editing) editingCommitIdRef.current = null;
  }, [editing]);

  const startEditingElement = useCallback((el: SceneElement) => {
    if (el.kind !== "text" && el.kind !== "sticky") return;
    const box = el as BoxElement;
    setSelected(new Set([el.id]));
    setEditing({ id: el.id, value: box.text ?? "" });
  }, []);

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
        e.preventDefault();
        setSelected(new Set());
        setEditing(null);
        setConfirmClear(false);
        setConfirmDelete(null);
        return;
      }
      if (!mod) {
        const match = TOOLS.find((t) => t.shortcut.toLowerCase() === e.key.toLowerCase());
        if (match) setTool(match.kind);
      }
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
      <ElementView
        key={el.id}
        el={el}
        selected={selected.has(el.id)}
        editing={editing?.id === el.id}
        arrowId={arrowId}
        onEdit={startEditingElement}
      />
    ));
  }, [arrowId, draft, editing, elements, selected, startEditingElement]);

  const motion = reduceMotion();
  const gridUnit = 24 * viewport.zoom;

  const activeName = boards.find((b) => b.id === activeId)?.name ?? "Whiteboard";

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
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        boardName={activeName}
      />

      <div className="wb-body">
        <BoardSidebar
          open={sidebarOpen}
          boards={boards}
          activeId={activeId}
          renaming={renaming}
          onSelect={switchBoard}
          onNew={() => void createBoard()}
          onStartRename={(b) => {
            renameCommitKeyRef.current = null;
            setRenaming({ id: b.id, value: b.name });
          }}
          onRenameChange={(value) => setRenaming((r) => (r ? { ...r, value } : r))}
          onCommitRename={() => void commitRename()}
          onCancelRename={() => setRenaming(null)}
          onRequestDelete={(b) => setConfirmDelete(b)}
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
          onPointerCancel={onPointerCancel}
          onWheel={onWheel}
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
        >
          <defs>
            <pattern
              id={gridId}
              width={gridUnit || 24}
              height={gridUnit || 24}
              patternUnits="userSpaceOnUse"
              patternTransform={`translate(${viewport.x % (gridUnit || 24)} ${viewport.y % (gridUnit || 24)})`}
            >
              <circle cx="1" cy="1" r="1" className="wb-grid-dot" />
            </pattern>
            <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          <rect className="wb-grid-bg" x="0" y="0" width="100%" height="100%" fill={`url(#${gridId})`} />
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

        {elements.length === 0 && !draft && !loadingBoard && (
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
      </div>

      {confirmClear && (
        <ModalDialog label="Clear board">
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
        </ModalDialog>
      )}

      {confirmDelete && (
        <ModalDialog label="Delete board">
            <h3>Delete “{confirmDelete.name}”?</h3>
            <p>This permanently removes the board and everything on it. This cannot be undone.</p>
            <div className="wb-modal__actions">
              <button type="button" className="wb-btn-ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="wb-btn-danger"
                onClick={() => void deleteBoard(confirmDelete)}
              >
                Delete board
              </button>
            </div>
        </ModalDialog>
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
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  boardName: string;
}

function Toolbar(props: ToolbarProps) {
  const {
    tool, setTool, color, setColor, strokeWidth, setStrokeWidth,
    canUndo: canU, canRedo: canR, onUndo, onRedo, onDelete, hasSelection, onExport, onClear, saveState,
    sidebarOpen, onToggleSidebar, boardName,
  } = props;
  return (
    <header className="wb-toolbar">
      <button
        type="button"
        className="wb-tool wb-tool--panel"
        aria-label={sidebarOpen ? "Hide boards" : "Show boards"}
        aria-pressed={sidebarOpen}
        title={sidebarOpen ? "Hide boards" : "Show boards"}
        onClick={onToggleSidebar}
      >
        {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
      </button>
      <span className="wb-boardname" title={boardName}>{boardName}</span>

      <div className="wb-divider" aria-hidden="true" />

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
// Board sidebar (files / switcher)
// ---------------------------------------------------------------------------

interface BoardSidebarProps {
  open: boolean;
  boards: BoardMeta[];
  activeId: string | null;
  renaming: { id: string; value: string } | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onStartRename: (b: BoardMeta) => void;
  onRenameChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (b: BoardMeta) => void;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function RenameInput({
  value,
  label,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);
  const committedRef = useRef(false);
  const commitOnce = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit();
  };
  // Focus on mount instead of `autoFocus` (which react-doctor flags for a11y).
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="wb-rename-input"
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (cancelledRef.current) {
          cancelledRef.current = false;
          return;
        }
        if (committedRef.current) return;
        commitOnce();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitOnce();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function BoardSidebar(props: BoardSidebarProps) {
  const {
    open, boards, activeId, renaming,
    onSelect, onNew, onStartRename, onRenameChange, onCommitRename, onCancelRename, onRequestDelete,
  } = props;
  const activeItemRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!open || !activeId) return;
    activeItemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, open]);

  if (!open) return null;
  return (
    <aside className="wb-sidebar" aria-label="Boards">
      <div className="wb-sidebar__head">
        <span className="wb-sidebar__title">Boards</span>
        <button type="button" className="wb-newboard" onClick={onNew} title="New board">
          <FilePlus2 size={15} /> <span>New board</span>
        </button>
      </div>

      {boards.length === 0 ? (
        <div className="wb-sidebar__empty">
          <p>No boards yet.</p>
          <button type="button" className="wb-newboard wb-newboard--cta" onClick={onNew}>
            <FilePlus2 size={15} /> Create your first board
          </button>
        </div>
      ) : (
        <ul className="wb-boardlist">
          {boards.map((b) => {
            const active = b.id === activeId;
            const isRenaming = renaming?.id === b.id;
            return (
              <li
                key={b.id}
                ref={active ? activeItemRef : undefined}
                className={active ? "wb-boarditem wb-boarditem--active" : "wb-boarditem"}
              >
                {isRenaming ? (
                  <RenameInput
                    value={renaming.value}
                    label={`Rename ${b.name}`}
                    onChange={onRenameChange}
                    onCommit={onCommitRename}
                    onCancel={onCancelRename}
                  />
                ) : (
                  <button
                    type="button"
                    className="wb-boarditem__open"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect(b.id)}
                    onDoubleClick={() => onStartRename(b)}
                  >
                    <span className="wb-boarditem__name">{b.name}</span>
                    {b.updatedAt > 0 && (
                      <span className="wb-boarditem__time">{relativeTime(b.updatedAt)}</span>
                    )}
                  </button>
                )}

                {isRenaming ? (
                  <button
                    type="button"
                    className="wb-boarditem__action"
                    aria-label="Confirm rename"
                    title="Save name"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onCommitRename}
                  >
                    <Check size={14} />
                  </button>
                ) : (
                  <div className="wb-boarditem__actions">
                    <button
                      type="button"
                      className="wb-boarditem__action"
                      aria-label={`Rename board ${b.name}`}
                      title="Rename"
                      onClick={() => onStartRename(b)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="wb-boarditem__action wb-boarditem__action--danger"
                      aria-label={`Delete board ${b.name}`}
                      title="Delete"
                      onClick={() => onRequestDelete(b)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
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

function ElementView({
  el,
  selected,
  editing,
  arrowId,
  onEdit,
}: {
  el: SceneElement;
  selected: boolean;
  editing: boolean;
  arrowId: string;
  onEdit: (el: SceneElement) => void;
}) {
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
        markerEnd={el.kind === "arrow" ? `url(#${arrowId})` : undefined}
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
      <g className={className} onDoubleClick={() => onEdit(el)}>
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
      <foreignObject
        x={x}
        y={y}
        width={Math.max(w, 40)}
        height={Math.max(h, 24)}
        className={className}
        onDoubleClick={() => onEdit(el)}
      >
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
  const cancelledRef = useRef(false);
  const committedRef = useRef(false);
  const commitOnce = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit();
  };
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  if (!element) return null;
  const left = element.x * viewport.zoom + viewport.x;
  const top = element.y * viewport.zoom + viewport.y;
  const width = Math.max(Math.abs(element.width) * viewport.zoom, 120);
  const height = Math.max(Math.abs(element.height) * viewport.zoom, 36);
  const fontSize = (18 + element.strokeWidth * 2) * viewport.zoom;
  return (
    <textarea
      ref={ref}
      className="wb-text-editor"
      aria-label="Edit text"
      value={editing.value}
      style={{ left, top, width, height, color: element.stroke, fontSize, lineHeight: 1.35 }}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (cancelledRef.current) {
          cancelledRef.current = false;
          return;
        }
        if (committedRef.current) return;
        commitOnce();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commitOnce();
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
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (el.kind === "pen") {
    const pen = el as PenElement;
    if (pen.points.length === 0) return;
    ctx.beginPath();
    if (pen.points.length === 1) {
      const p = pen.points[0];
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.1, p.y + 0.1);
    } else {
      ctx.moveTo(pen.points[0].x, pen.points[0].y);
      for (let i = 1; i < pen.points.length; i += 1) {
        const prev = pen.points[i - 1];
        const curr = pen.points[i];
        ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + curr.x) / 2, (prev.y + curr.y) / 2);
      }
    }
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
      const leftX = l.x2 - size * Math.cos(angle - Math.PI / 6);
      const leftY = l.y2 - size * Math.sin(angle - Math.PI / 6);
      const rightX = l.x2 - size * Math.cos(angle + Math.PI / 6);
      const rightY = l.y2 - size * Math.sin(angle + Math.PI / 6);
      ctx.beginPath();
      ctx.moveTo(l.x2, l.y2);
      ctx.lineTo(leftX, leftY);
      ctx.lineTo(rightX, rightY);
      ctx.closePath();
      ctx.fillStyle = el.stroke;
      ctx.fill();
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
    if (el.fill !== "transparent") {
      ctx.fillStyle = el.fill;
      ctx.fill();
    }
    ctx.stroke();
    return;
  }
  if (el.kind === "sticky") {
    ctx.fillStyle = b.fill;
    roundedRectPath(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(50,53,46,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
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
  roundedRectPath(ctx, x, y, w, h, 8);
  if (el.fill !== "transparent") {
    ctx.fillStyle = el.fill;
    ctx.fill();
  }
  ctx.stroke();
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  let cursorY = y;
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  for (const [index, paragraph] of paragraphs.entries()) {
    const words = paragraph.split(/[ \t]+/).filter((word) => word.length > 0);
    let line = "";
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
    if (line) {
      ctx.fillText(line, x, cursorY);
    }
    if (index < paragraphs.length - 1 || !line) {
      cursorY += lineHeight;
    }
  }
}
