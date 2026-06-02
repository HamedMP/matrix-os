import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  GripVertical,
  LayoutDashboard,
  ListChecks,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  addCard,
  addChecklistItem,
  addColumn,
  createSeedBoard,
  deleteCard,
  deleteColumn,
  moveCard,
  moveColumn,
  renameColumn,
  toggleChecklistItem,
  updateCard,
  type Board,
  type BoardColumn,
  type Card,
  type ChecklistItem,
  type Priority,
} from "./board-model";
import {
  CARDS_TABLE,
  COLUMNS_TABLE,
  boardFromRows,
  cardToRow,
  columnToRow,
  emptyBoard,
  loadBridgeBoard,
  loadLocalBoard,
  saveLocalBoard,
} from "./persistence";
import "./styles.css";

const PRIORITY_ORDER: Priority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_LABEL: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const LABEL_PALETTE = ["#D06F25", "#3A7D44", "#434E3F", "#D49B2A", "#C4342D", "#7A7768"];

function labelColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return LABEL_PALETTE[hash % LABEL_PALETTE.length];
}

function db(): NonNullable<Window["MatrixOS"]>["db"] | undefined {
  return typeof window !== "undefined" ? window.MatrixOS?.db : undefined;
}

type MatrixDb = NonNullable<NonNullable<Window["MatrixOS"]>["db"]>;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checklistProgress(checklist: ChecklistItem[]): { done: number; total: number } {
  return { done: checklist.filter((item) => item.done).length, total: checklist.length };
}

function dueState(due: string): "overdue" | "soon" | "none" | "later" {
  if (!due) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(`${due}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "none";
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diff < 0) return "overdue";
  if (diff <= 2) return "soon";
  return "later";
}

function formatDue(due: string): string {
  const date = new Date(`${due}T00:00:00`);
  if (Number.isNaN(date.getTime())) return due;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function persistBoardToBridge(bridge: MatrixDb, source: Board): Promise<Board> {
  const columnIdMap = new Map<string, string>();
  const insertedColumnIds: string[] = [];
  const insertedCardIds: string[] = [];
  try {
    for (let i = 0; i < source.columns.length; i += 1) {
      const column = source.columns[i];
      const result = await bridge.insert(COLUMNS_TABLE, columnToRow(column, i));
      insertedColumnIds.push(result.id);
      columnIdMap.set(column.id, result.id);
    }
    for (const card of source.cards) {
      const result = await bridge.insert(CARDS_TABLE, {
        ...cardToRow(card, card.order),
        column_id: columnIdMap.get(card.columnId) ?? card.columnId,
      });
      insertedCardIds.push(result.id);
    }
  } catch (err) {
    for (const cardId of [...insertedCardIds].reverse()) {
      await bridge.delete(CARDS_TABLE, cardId).catch((cleanupErr: unknown) => {
        console.warn("[task-manager] seed card cleanup failed:", errMessage(cleanupErr));
      });
    }
    for (const columnId of [...insertedColumnIds].reverse()) {
      await bridge.delete(COLUMNS_TABLE, columnId).catch((cleanupErr: unknown) => {
        console.warn("[task-manager] seed column cleanup failed:", errMessage(cleanupErr));
      });
    }
    throw err;
  }
  const [columnRows, cardRows] = await Promise.all([
    bridge.find(COLUMNS_TABLE, { orderBy: { position: "asc" } }),
    bridge.find(CARDS_TABLE, { orderBy: { position: "asc" } }),
  ]);
  return boardFromRows(columnRows, cardRows);
}

function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; index: number } | null>(null);
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [columnDrafts, setColumnDrafts] = useState<Record<string, string>>({});
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnTitle, setNewColumnTitle] = useState("");

  const boardRef = useRef<Board | null>(null);
  boardRef.current = board;
  const pendingColumnIdsRef = useRef<Record<string, Promise<string> | undefined>>({});
  const pendingCardIdsRef = useRef<Record<string, Promise<string> | undefined>>({});
  const pendingCardIdSwapsRef = useRef<Record<string, string | undefined>>({});
  const deletingColumnIdsRef = useRef<Set<string>>(new Set());
  const usingDbRef = useRef(false);
  const suppressReloadRef = useRef(false);

  const reload = useCallback(async () => {
    const bridge = db();
    if (!bridge) {
      usingDbRef.current = false;
      const local = loadLocalBoard();
      const next = local && local.columns?.length ? local : createSeedBoard();
      setBoard(next);
      if (!local) saveLocalBoard(next);
      return true;
    }
    usingDbRef.current = true;
    try {
      const [columnRows, cardRows] = await Promise.all([
        bridge.find(COLUMNS_TABLE, { orderBy: { position: "asc" } }),
        bridge.find(CARDS_TABLE, { orderBy: { position: "asc" } }),
      ]);
      if (columnRows.length === 0) {
        const legacy = await loadBridgeBoard();
        if (legacy) {
          suppressReloadRef.current = true;
          try {
            setBoard(await persistBoardToBridge(bridge, legacy));
          } finally {
            suppressReloadRef.current = false;
          }
          setError(null);
          return true;
        }
        // First run: seed the default workflow columns into Postgres.
        const seed = emptyBoard();
        suppressReloadRef.current = true;
        try {
          setBoard(await persistBoardToBridge(bridge, seed));
        } finally {
          suppressReloadRef.current = false;
        }
        setError(null);
        return true;
      }
      setBoard(boardFromRows(columnRows, cardRows));
      setError(null);
      return true;
    } catch (err: unknown) {
      console.warn("[task-manager] load failed:", errMessage(err));
      setError("Board could not be loaded. Retrying may help.");
      return false;
    }
  }, []);

  useEffect(() => {
    void reload();
    const bridge = db();
    if (!bridge) return undefined;
    const guardedReload = () => {
      if (!suppressReloadRef.current) void reload();
    };
    const offColumns = bridge.onChange(COLUMNS_TABLE, guardedReload);
    const offCards = bridge.onChange(CARDS_TABLE, guardedReload);
    return () => {
      offColumns?.();
      offCards?.();
    };
  }, [reload]);

  useEffect(() => {
    if (!selectedCardId) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedCardId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCardId]);

  // Persist a localStorage snapshot whenever the board changes in fallback mode.
  useEffect(() => {
    if (board && !usingDbRef.current) saveLocalBoard(board);
  }, [board]);

  const persist = useCallback(async (action: () => Promise<void>, failure: string) => {
    if (!usingDbRef.current) return;
    try {
      await action();
    } catch (err: unknown) {
      console.warn(`[task-manager] ${failure}:`, errMessage(err));
      const refreshed = await reload();
      setError(refreshed ? `${failure}. The board has been refreshed.` : `${failure}. Reopen the board to refresh.`);
    }
  }, [reload]);

  const resolveCardId = useCallback((cardId: string): Promise<string> => {
    return pendingCardIdsRef.current[cardId] ?? Promise.resolve(cardId);
  }, []);

  // --- Card mutations (optimistic) ---

  const createCard = useCallback((columnId: string, title: string) => {
    const current = boardRef.current;
    if (!current || !title.trim()) return;
    if (deletingColumnIdsRef.current.has(columnId)) return;
    const projectId = current.projects[0]?.id ?? "project-default";
    const existing = new Set(current.cards.map((card) => card.id));
    const next = addCard(current, { columnId, projectId, title });
    setBoard(next);
    boardRef.current = next;
    const created = next.cards.find((card) => !existing.has(card.id));
    if (!created) return;
    let resolveCreatedCardId: (id: string) => void = () => undefined;
    let rejectCreatedCardId: (err: unknown) => void = () => undefined;
    const pendingCardId = new Promise<string>((resolve, reject) => {
      resolveCreatedCardId = resolve;
      rejectCreatedCardId = reject;
    });
    pendingCardId.catch(() => undefined);
    pendingCardIdsRef.current[created.id] = pendingCardId;
    void persist(async () => {
      const bridge = db();
      if (!bridge) {
        resolveCreatedCardId(created.id);
        return;
      }
      try {
        let liveCard = boardRef.current?.cards.find((card) => card.id === created.id);
        if (!liveCard) {
          resolveCreatedCardId(created.id);
          return;
        }
        const liveColumnExists = boardRef.current?.columns.some((column) => column.id === liveCard.columnId) ?? false;
        if (!liveColumnExists) {
          resolveCreatedCardId(created.id);
          return;
        }
        const pendingColumnId = liveCard.columnId;
        let columnId = await (pendingColumnIdsRef.current[pendingColumnId] ?? Promise.resolve(pendingColumnId));
        liveCard = boardRef.current?.cards.find((card) => card.id === created.id);
        if (!liveCard) {
          resolveCreatedCardId(created.id);
          return;
        }
        const latestColumnExists = boardRef.current?.columns.some((column) => column.id === liveCard.columnId) ?? false;
        if (!latestColumnExists) {
          resolveCreatedCardId(created.id);
          return;
        }
        if (liveCard.columnId !== pendingColumnId) {
          columnId = await (pendingColumnIdsRef.current[liveCard.columnId] ?? Promise.resolve(liveCard.columnId));
        }
        const result = await bridge.insert(CARDS_TABLE, cardToRow({ ...liveCard, columnId }, liveCard.order));
        resolveCreatedCardId(result.id);
        pendingCardIdSwapsRef.current[result.id] = created.id;
        window.setTimeout(() => {
          delete pendingCardIdSwapsRef.current[result.id];
        }, 0);
        setSelectedCardId((id) => (id === created.id ? result.id : id));
        setBoard((current) => current ? {
          ...current,
          cards: current.cards.map((card) => card.id === created.id ? { ...card, id: result.id } : card),
        } : current);
      } catch (err) {
        rejectCreatedCardId(err);
        throw err;
      } finally {
        delete pendingCardIdsRef.current[created.id];
      }
    }, "Card could not be saved");
  }, [persist, reload]);

  const patchCard = useCallback((cardId: string, patch: Partial<Omit<Card, "id" | "createdAt">>) => {
    const current = boardRef.current;
    if (!current) return;
    const next = updateCard(current, cardId, patch);
    setBoard(next);
    boardRef.current = next;
    const updated = next.cards.find((card) => card.id === cardId);
    if (!updated) return;
    void persist(async () => {
      const bridge = db();
      if (!bridge) return;
      const persistedCardId = await resolveCardId(cardId);
      const liveCard = boardRef.current?.cards.find((card) => card.id === persistedCardId)
        ?? boardRef.current?.cards.find((card) => card.id === cardId);
      const rowCard = liveCard
        ? { ...updated, columnId: liveCard.columnId, order: liveCard.order, checklist: liveCard.checklist }
        : updated;
      const persistedColumnId = await (
        pendingColumnIdsRef.current[rowCard.columnId] ?? Promise.resolve(rowCard.columnId)
      );
      await bridge.update(
        CARDS_TABLE,
        persistedCardId,
        cardToRow({ ...rowCard, id: persistedCardId, columnId: persistedColumnId }, rowCard.order),
      );
    }, "Card could not be updated");
  }, [persist, resolveCardId]);

  const removeCard = useCallback((cardId: string) => {
    const current = boardRef.current;
    if (!current) return;
    const next = deleteCard(current, cardId);
    setBoard(next);
    boardRef.current = next;
    setSelectedCardId((id) => (id === cardId ? null : id));
    void persist(async () => {
      const bridge = db();
      if (!bridge) return;
      await bridge.delete(CARDS_TABLE, await resolveCardId(cardId));
    }, "Card could not be deleted");
  }, [persist, resolveCardId]);

  const dropCard = useCallback((cardId: string, targetColumnId: string, targetIndex: number) => {
    const current = boardRef.current;
    if (!current) return;
    if (deletingColumnIdsRef.current.has(targetColumnId)) return;
    const before = current.cards.find((card) => card.id === cardId);
    const next = moveCard(current, cardId, targetColumnId, targetIndex);
    setBoard(next);
    boardRef.current = next;
    // Persist new column + position for every card in affected columns.
    const affected = new Set([before?.columnId, targetColumnId].filter(Boolean) as string[]);
    void persist(async () => {
      const bridge = db();
      if (!bridge) return;
      const cardIds = next.cards.filter((card) => affected.has(card.columnId)).map((card) => card.id);
      for (const cardId of cardIds) {
        const persistedCardId = await resolveCardId(cardId);
        const liveCard = boardRef.current?.cards.find((card) => card.id === persistedCardId)
          ?? boardRef.current?.cards.find((card) => card.id === cardId)
          ?? next.cards.find((card) => card.id === cardId);
        if (!liveCard) continue;
        const persistedColumnId = await (
          pendingColumnIdsRef.current[liveCard.columnId] ?? Promise.resolve(liveCard.columnId)
        );
        await bridge.update(CARDS_TABLE, persistedCardId, {
          column_id: persistedColumnId,
          position: liveCard.order,
        });
      }
    }, "Card order could not be saved");
  }, [persist, resolveCardId]);

  // --- Checklist (within selected card) ---

  const toggleChecklist = useCallback((cardId: string, itemId: string) => {
    const current = boardRef.current;
    if (!current) return;
    const next = toggleChecklistItem(current, cardId, itemId);
    setBoard(next);
    boardRef.current = next;
    const updated = next.cards.find((card) => card.id === cardId);
    if (!updated) return;
    void persist(async () => {
      const bridge = db();
      if (!bridge) return;
      const persistedCardId = await resolveCardId(cardId);
      const liveCard = boardRef.current?.cards.find((card) => card.id === persistedCardId)
        ?? boardRef.current?.cards.find((card) => card.id === cardId);
      await bridge.update(CARDS_TABLE, persistedCardId, { checklist: liveCard?.checklist ?? updated.checklist });
    }, "Checklist could not be saved");
  }, [persist, resolveCardId]);

  const addChecklist = useCallback((cardId: string, text: string) => {
    const current = boardRef.current;
    if (!current || !text.trim()) return;
    const next = addChecklistItem(current, cardId, text);
    setBoard(next);
    boardRef.current = next;
    const updated = next.cards.find((card) => card.id === cardId);
    if (!updated) return;
    void persist(async () => {
      const bridge = db();
      if (!bridge) return;
      const persistedCardId = await resolveCardId(cardId);
      const liveCard = boardRef.current?.cards.find((card) => card.id === persistedCardId)
        ?? boardRef.current?.cards.find((card) => card.id === cardId);
      await bridge.update(CARDS_TABLE, persistedCardId, { checklist: liveCard?.checklist ?? updated.checklist });
    }, "Checklist could not be saved");
  }, [persist, resolveCardId]);

  // --- Column mutations ---

  const createColumn = useCallback((title: string) => {
    const current = boardRef.current;
    if (!current || !title.trim()) return;
    const existing = new Set(current.columns.map((column) => column.id));
    const next = addColumn(current, title);
    setBoard(next);
    boardRef.current = next;
    const created = next.columns.find((column) => !existing.has(column.id));
    if (!created) return;
    const position = next.columns.findIndex((column) => column.id === created.id);
    let resolveColumnId: (id: string) => void = () => undefined;
    let rejectColumnId: (err: unknown) => void = () => undefined;
    const pendingColumnId = new Promise<string>((resolve, reject) => {
      resolveColumnId = resolve;
      rejectColumnId = reject;
    });
    pendingColumnId.catch(() => undefined);
    pendingColumnIdsRef.current[created.id] = pendingColumnId;
    void (async () => {
      if (!usingDbRef.current) {
        resolveColumnId(created.id);
        delete pendingColumnIdsRef.current[created.id];
        return;
      }
      const bridge = db();
      if (!bridge) {
        resolveColumnId(created.id);
        return;
      }
      try {
        const result = await bridge.insert(COLUMNS_TABLE, columnToRow(created, position));
        resolveColumnId(result.id);
        const latest = boardRef.current;
        if (latest) {
          const next = {
            ...latest,
            columns: latest.columns.map((column) => column.id === created.id ? { ...column, id: result.id } : column),
            cards: latest.cards.map((card) => card.columnId === created.id ? { ...card, columnId: result.id } : card),
          };
          boardRef.current = next;
          setBoard(next);
        }
      } catch (err) {
        rejectColumnId(err);
        console.warn("[task-manager] Column could not be created:", errMessage(err));
        await reload();
        setError("Column could not be created. Reopen the board to refresh.");
      } finally {
        delete pendingColumnIdsRef.current[created.id];
      }
    })();
  }, [reload]);

  const renameBoardColumn = useCallback((columnId: string, title: string) => {
    if (!boardRef.current) return;
    const trimmedTitle = title.trim();
    setBoard((current) => (current ? renameColumn(current, columnId, title) : current));
    if (!trimmedTitle) return;
    void persist(async () => {
      const bridge = db();
      if (!bridge) return;
      const persistedColumnId = await (pendingColumnIdsRef.current[columnId] ?? Promise.resolve(columnId));
      await bridge.update(COLUMNS_TABLE, persistedColumnId, { title: trimmedTitle });
    }, "Column could not be renamed");
  }, [persist]);

  const removeColumn = useCallback((columnId: string) => {
    const current = boardRef.current;
    if (!current || current.columns.length <= 1) return;
    const removedCards = current.cards.filter((card) => card.columnId === columnId).map((card) => card.id);
    const bridge = db();
    if (!usingDbRef.current || !bridge) {
      setBoard((latest) => {
        if (!latest) return latest;
        const next = deleteColumn(latest, columnId);
        boardRef.current = next;
        return next;
      });
      return;
    }
    if (deletingColumnIdsRef.current.has(columnId)) return;
    deletingColumnIdsRef.current.add(columnId);
    suppressReloadRef.current = true;
    void (async () => {
      let persistedDeleteColumnId: string | null = null;
      try {
        for (const cardId of removedCards) {
          await bridge.delete(CARDS_TABLE, await resolveCardId(cardId));
        }
        const persistedColumnId = await (pendingColumnIdsRef.current[columnId] ?? Promise.resolve(columnId));
        persistedDeleteColumnId = persistedColumnId;
        deletingColumnIdsRef.current.add(persistedColumnId);
        await bridge.delete(COLUMNS_TABLE, persistedColumnId);
        setError(null);
        setBoard((latest) => {
          if (!latest) return latest;
          const deleteId = latest.columns.some((column) => column.id === persistedColumnId)
            ? persistedColumnId
            : columnId;
          const next = deleteColumn(latest, deleteId);
          boardRef.current = next;
          return next;
        });
      } catch (err: unknown) {
        console.warn("[task-manager] Column could not be deleted:", errMessage(err));
        await reload();
        setError("Column could not be deleted. Reopen the board to refresh.");
      } finally {
        deletingColumnIdsRef.current.delete(columnId);
        if (persistedDeleteColumnId) deletingColumnIdsRef.current.delete(persistedDeleteColumnId);
        suppressReloadRef.current = false;
      }
    })();
  }, [reload, resolveCardId]);

  const dropColumn = useCallback((columnId: string, targetIndex: number) => {
    const current = boardRef.current;
    if (!current) return;
    const next = moveColumn(current, columnId, targetIndex);
    setBoard(next);
    boardRef.current = next;
    void persist(async () => {
      const bridge = db();
      if (!bridge) return;
      const columnIds = next.columns.map((column) => column.id);
      for (const originalColumnId of columnIds) {
        const persistedColumnId = await (
          pendingColumnIdsRef.current[originalColumnId] ?? Promise.resolve(originalColumnId)
        );
        const liveColumns = boardRef.current?.columns ?? next.columns;
        const liveIndex = liveColumns.findIndex((column) =>
          column.id === persistedColumnId || column.id === originalColumnId,
        );
        if (liveIndex < 0) continue;
        await bridge.update(COLUMNS_TABLE, persistedColumnId, { position: liveIndex });
      }
    }, "Column order could not be saved");
  }, [persist]);

  // --- Derived ---

  const allLabels = useMemo(() => {
    if (!board) return [];
    const set = new Set<string>();
    for (const card of board.cards) for (const label of card.labels) set.add(label);
    return [...set].sort();
  }, [board]);

  const filteredCards = useMemo(() => {
    if (!board) return [];
    const q = query.trim().toLowerCase();
    return board.cards.filter((card) => {
      if (labelFilter && !card.labels.includes(labelFilter)) return false;
      if (!q) return true;
      return [card.title, card.description, card.assignee, ...card.labels]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [board, labelFilter, query]);

  const totalShown = filteredCards.length;
  const selectedCard = board?.cards.find((card) => card.id === selectedCardId) ?? null;
  const isFiltering = Boolean(query.trim()) || Boolean(labelFilter);

  if (!board) {
    return (
      <main className="board-shell board-shell--loading">
        <div className="loading">{error ?? "Opening Task Manager…"}</div>
      </main>
    );
  }

  return (
    <main className="board-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="app-icon"><LayoutDashboard size={22} /></span>
          <div>
            <span className="eyebrow">Project board</span>
            <h1>Task Manager</h1>
          </div>
        </div>
        <div className="header-tools">
          <label className="search-field">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search cards"
              aria-label="Search cards"
            />
          </label>
        </div>
      </header>

      {allLabels.length > 0 ? (
        <div className="filter-bar" aria-label="Label filters">
          <button
            type="button"
            className={labelFilter === null ? "label-chip label-chip--active" : "label-chip"}
            onClick={() => setLabelFilter(null)}
          >
            All
          </button>
          {allLabels.map((label) => (
            <button
              type="button"
              key={label}
              className={labelFilter === label ? "label-chip label-chip--active" : "label-chip"}
              style={{ "--chip": labelColor(label) } as React.CSSProperties}
              onClick={() => setLabelFilter((current) => (current === label ? null : label))}
            >
              <span className="label-chip__dot" />
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <section className="board" aria-label="Kanban board">
        {board.columns.map((column, columnIndex) => {
          const cards = filteredCards
            .filter((card) => card.columnId === column.id)
            .sort((a, b) => a.order - b.order);
          const total = board.cards.filter((card) => card.columnId === column.id).length;
          return (
            <BoardColumnView
              key={column.id}
              column={column}
              columnIndex={columnIndex}
              cards={cards}
              total={total}
              shownCount={cards.length}
              isFiltering={isFiltering}
              isEditing={editingColumnId === column.id}
              draftValue={columnDrafts[column.id] ?? ""}
              draggingCardId={draggingCardId}
              draggingColumnId={draggingColumnId}
              dropTarget={dropTarget?.columnId === column.id ? dropTarget.index : null}
              onStartEdit={() => setEditingColumnId(column.id)}
              onRename={(value) => {
                renameBoardColumn(column.id, value);
                setEditingColumnId(null);
              }}
              onCancelEdit={() => setEditingColumnId(null)}
              onDelete={() => removeColumn(column.id)}
              canDelete={board.columns.length > 1}
              onDraftChange={(value) => setColumnDrafts((drafts) => ({ ...drafts, [column.id]: value }))}
              onAddCard={() => {
                createCard(column.id, columnDrafts[column.id] ?? "");
                setColumnDrafts((drafts) => ({ ...drafts, [column.id]: "" }));
              }}
              onCardDragStart={(cardId) => setDraggingCardId(cardId)}
              onCardDragEnd={() => {
                setDraggingCardId(null);
                setDropTarget(null);
              }}
              onColumnDragStart={() => setDraggingColumnId(column.id)}
              onColumnDragEnd={() => setDraggingColumnId(null)}
              onColumnDrop={() => {
                if (draggingColumnId && draggingColumnId !== column.id) {
                  dropColumn(draggingColumnId, columnIndex);
                }
                setDraggingColumnId(null);
              }}
              onSetDropTarget={(index) => setDropTarget({ columnId: column.id, index })}
              onCardDrop={(index) => {
                if (draggingCardId) dropCard(draggingCardId, column.id, index);
                setDraggingCardId(null);
                setDropTarget(null);
              }}
              onOpenCard={(cardId) => setSelectedCardId(cardId)}
            />
          );
        })}

        <div className="column-adder">
          {addingColumn ? (
            <form
              className="column-adder__form"
              onSubmit={(event) => {
                event.preventDefault();
                createColumn(newColumnTitle);
                setNewColumnTitle("");
                setAddingColumn(false);
              }}
            >
              <input
                autoFocus
                value={newColumnTitle}
                onChange={(event) => setNewColumnTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setAddingColumn(false);
                    setNewColumnTitle("");
                  }
                }}
                placeholder="Column name"
              />
              <div className="column-adder__actions">
                <button className="button button--primary" type="submit"><Check size={14} />Add</button>
                <button className="icon-button" type="button" onClick={() => { setAddingColumn(false); setNewColumnTitle(""); }}>
                  <X size={15} />
                </button>
              </div>
            </form>
          ) : (
            <button className="column-adder__trigger" type="button" onClick={() => setAddingColumn(true)}>
              <Plus size={16} />
              Add column
            </button>
          )}
        </div>
      </section>

      {board.cards.length === 0 && !isFiltering ? (
        <div className="empty-state" role="status">
          <span className="empty-state__icon"><ListChecks size={28} /></span>
          <h2>Plan your first project</h2>
          <p>Add a card to any column to start tracking work. Drag cards to move them across your workflow.</p>
        </div>
      ) : null}

      {totalShown === 0 && isFiltering ? (
        <div className="empty-state empty-state--filter" role="status">
          <span className="empty-state__icon"><Search size={24} /></span>
          <h2>No matching cards</h2>
          <p>Try a different search term or clear the label filter.</p>
        </div>
      ) : null}

      {selectedCard ? (
        <CardDetail
          card={selectedCard}
          columns={board.columns}
          pendingSwapFromId={pendingCardIdSwapsRef.current[selectedCard.id] ?? null}
          onClose={() => setSelectedCardId(null)}
          onPatch={(patch) => patchCard(selectedCard.id, patch)}
          onMoveColumn={(columnId) => {
            const count = board.cards.filter((card) => card.columnId === columnId).length;
            dropCard(selectedCard.id, columnId, count);
          }}
          onToggleChecklist={(itemId) => toggleChecklist(selectedCard.id, itemId)}
          onAddChecklist={(text) => addChecklist(selectedCard.id, text)}
          onDelete={() => removeCard(selectedCard.id)}
        />
      ) : null}
    </main>
  );
}

interface ColumnViewProps {
  column: BoardColumn;
  columnIndex: number;
  cards: Card[];
  total: number;
  shownCount: number;
  isFiltering: boolean;
  isEditing: boolean;
  draftValue: string;
  draggingCardId: string | null;
  draggingColumnId: string | null;
  dropTarget: number | null;
  canDelete: boolean;
  onStartEdit: () => void;
  onRename: (value: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onDraftChange: (value: string) => void;
  onAddCard: () => void;
  onCardDragStart: (cardId: string) => void;
  onCardDragEnd: () => void;
  onColumnDragStart: () => void;
  onColumnDragEnd: () => void;
  onColumnDrop: () => void;
  onSetDropTarget: (index: number) => void;
  onCardDrop: (index: number) => void;
  onOpenCard: (cardId: string) => void;
}

function BoardColumnView(props: ColumnViewProps) {
  const {
    column, cards, total, shownCount, isFiltering, isEditing, draftValue,
    draggingCardId, draggingColumnId, dropTarget, canDelete,
    onStartEdit, onRename, onCancelEdit, onDelete, onDraftChange, onAddCard,
    onCardDragStart, onCardDragEnd, onColumnDragStart, onColumnDragEnd, onColumnDrop,
    onSetDropTarget, onCardDrop, onOpenCard,
  } = props;
  const [renameValue, setRenameValue] = useState(column.title);
  const skipNextRenameBlurRef = useRef(false);
  useEffect(() => setRenameValue(column.title), [column.title]);

  const isColumnDropTarget = draggingColumnId !== null && draggingColumnId !== column.id;

  return (
    <section
      className={draggingColumnId === column.id ? "column column--dragging" : "column"}
      aria-label={column.title}
      onDragOver={(event) => {
        if (draggingColumnId && draggingColumnId !== column.id) event.preventDefault();
        else if (draggingCardId && !isFiltering) {
          event.preventDefault();
          onSetDropTarget(cards.length);
        }
      }}
      onDrop={(event) => {
        if (draggingColumnId && draggingColumnId !== column.id) {
          event.preventDefault();
          onColumnDrop();
          return;
        }
        if (draggingCardId && !isFiltering) {
          event.preventDefault();
          onCardDrop(cards.length);
        }
      }}
    >
      <header className="column__header">
        <span
          className="column__grip"
          draggable
          onDragStart={onColumnDragStart}
          onDragEnd={onColumnDragEnd}
          title="Reorder column"
        >
          <span className="column__swatch" style={{ background: column.color }} />
          <GripVertical size={13} />
        </span>
        {isEditing ? (
          <form
            className="column__rename"
            onSubmit={(event) => {
              event.preventDefault();
              skipNextRenameBlurRef.current = true;
              onRename(renameValue);
            }}
          >
            <input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={() => {
                if (skipNextRenameBlurRef.current) {
                  skipNextRenameBlurRef.current = false;
                  return;
                }
                onRename(renameValue);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  skipNextRenameBlurRef.current = true;
                  setRenameValue(column.title);
                  onCancelEdit();
                }
              }}
            />
          </form>
        ) : (
          <button className="column__title" type="button" onClick={onStartEdit} title="Rename column">
            <h2>{column.title}</h2>
            <span className="column__count">
              {isFiltering && shownCount !== total ? `${shownCount}/${total}` : total}
            </span>
          </button>
        )}
        <div className="column__menu">
          <button className="icon-button icon-button--ghost" type="button" onClick={onStartEdit} title="Rename column">
            <Pencil size={13} />
          </button>
          {canDelete ? (
            <button className="icon-button icon-button--ghost" type="button" onClick={onDelete} title="Delete column">
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
      </header>

      <div className={isColumnDropTarget ? "column__cards column__cards--target" : "column__cards"}>
        {cards.map((card, index) => (
          <div key={card.id} className="card-slot">
            {dropTarget === index && draggingCardId ? <div className="drop-indicator" /> : null}
            <div
              onDragOver={(event) => {
                if (!draggingCardId || isFiltering) return;
                event.preventDefault();
                event.stopPropagation();
                onSetDropTarget(index);
              }}
              onDrop={(event) => {
                if (!draggingCardId) return;
                event.preventDefault();
                event.stopPropagation();
                if (isFiltering) return;
                onCardDrop(index);
              }}
            >
              <TaskCardView
                card={card}
                onOpen={() => onOpenCard(card.id)}
                onDragStart={() => onCardDragStart(card.id)}
                onDragEnd={onCardDragEnd}
              />
            </div>
          </div>
        ))}
        {dropTarget === cards.length && draggingCardId ? <div className="drop-indicator" /> : null}
        {cards.length === 0 ? (
          <div className="column-empty">
            <Circle size={14} />
            <span>{isFiltering ? "No matches" : "Drop a card here"}</span>
          </div>
        ) : null}
      </div>

      <form
        className="column__quick-add"
        onSubmit={(event) => { event.preventDefault(); onAddCard(); }}
      >
        <input
          value={draftValue}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAddCard();
            }
          }}
          placeholder={`Add a card to ${column.title}`}
          aria-label={`Add a card to ${column.title}`}
        />
        <button className="icon-button icon-button--compact" type="submit" title="Add card">
          <Plus size={15} />
        </button>
      </form>
    </section>
  );
}

function TaskCardView({
  card,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  card: Card;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const progress = checklistProgress(card.checklist);
  const due = dueState(card.dueDate);
  return (
    <article
      className="task-card"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {card.labels.length > 0 ? (
        <div className="task-card__labels">
          {card.labels.map((label) => (
            <span className="task-card__label" key={label} style={{ background: labelColor(label) }} title={label} />
          ))}
        </div>
      ) : null}
      <h3 className="task-card__title">{card.title}</h3>
      {card.description ? <p className="task-card__desc">{card.description}</p> : null}
      <footer className="task-card__meta">
        {card.priority !== "medium" ? (
          <span className={`pill pill--${card.priority}`}>{PRIORITY_LABEL[card.priority]}</span>
        ) : null}
        {card.dueDate ? (
          <span className={`meta meta--due-${due}`}>
            <CalendarDays size={12} />
            {formatDue(card.dueDate)}
          </span>
        ) : null}
        {progress.total > 0 ? (
          <span className={progress.done === progress.total ? "meta meta--done" : "meta"}>
            <CheckCircle2 size={12} />
            {progress.done}/{progress.total}
          </span>
        ) : null}
        {card.assignee ? (
          <span className="meta meta--assignee" title={card.assignee}>
            <User size={12} />
            {card.assignee}
          </span>
        ) : null}
      </footer>
    </article>
  );
}

function CardDetail({
  card,
  columns,
  pendingSwapFromId,
  onClose,
  onPatch,
  onMoveColumn,
  onToggleChecklist,
  onAddChecklist,
  onDelete,
}: {
  card: Card;
  columns: BoardColumn[];
  pendingSwapFromId: string | null;
  onClose: () => void;
  onPatch: (patch: Partial<Omit<Card, "id" | "createdAt">>) => void;
  onMoveColumn: (columnId: string) => void;
  onToggleChecklist: (itemId: string) => void;
  onAddChecklist: (text: string) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [assignee, setAssignee] = useState(card.assignee);
  const [labelInput, setLabelInput] = useState("");
  const [checklistInput, setChecklistInput] = useState("");
  const previousCardRef = useRef(card);
  useEffect(() => {
    const previous = previousCardRef.current;
    const sameCard = previous.id === card.id || pendingSwapFromId === previous.id;
    if (!sameCard || title === previous.title) setTitle(card.title);
    if (!sameCard || description === previous.description) setDescription(card.description);
    if (!sameCard || assignee === previous.assignee) setAssignee(card.assignee);
    if (!sameCard) {
      setLabelInput("");
      setChecklistInput("");
    }
    previousCardRef.current = card;
  }, [assignee, card, description, pendingSwapFromId, title]);

  const progress = checklistProgress(card.checklist);

  const addLabel = () => {
    const value = labelInput.trim();
    if (!value || card.labels.includes(value)) {
      setLabelInput("");
      return;
    }
    onPatch({ labels: [...card.labels, value] });
    setLabelInput("");
  };

  return (
    <div className="detail-overlay" role="dialog" aria-modal="true" aria-label="Card details">
      <div className="detail-overlay__backdrop" onClick={onClose} />
      <section className="detail-sheet">
        <header className="detail-sheet__header">
          <span className="eyebrow">Card</span>
          <button className="icon-button" type="button" onClick={onClose} title="Close" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <input
          className="detail-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => { if (title.trim() && title.trim() !== card.title) onPatch({ title: title.trim() }); else setTitle(card.title); }}
          aria-label="Card title"
        />

        <div className="detail-grid">
          <label className="field">
            <span>Column</span>
            <select value={card.columnId} onChange={(event) => onMoveColumn(event.target.value)}>
              {columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <select value={card.priority} onChange={(event) => onPatch({ priority: event.target.value as Priority })}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Due date</span>
            <input type="date" value={card.dueDate} onChange={(event) => onPatch({ dueDate: event.target.value })} />
          </label>
          <label className="field">
            <span>Assignee</span>
            <input
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              onBlur={() => { if (assignee !== card.assignee) onPatch({ assignee: assignee.trim() }); }}
              placeholder="Unassigned"
            />
          </label>
        </div>

        <label className="field field--block">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => { if (description !== card.description) onPatch({ description }); }}
            placeholder="Add more detail…"
            rows={3}
          />
        </label>

        <div className="field field--block">
          <span className="field__label"><Tag size={13} />Labels</span>
          <div className="label-editor">
            {card.labels.map((label) => (
              <span className="label-tag" key={label} style={{ background: labelColor(label) }}>
                {label}
                <button type="button" onClick={() => onPatch({ labels: card.labels.filter((l) => l !== label) })} aria-label={`Remove ${label}`}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <form onSubmit={(event) => { event.preventDefault(); addLabel(); }}>
              <input
                value={labelInput}
                onChange={(event) => setLabelInput(event.target.value)}
                placeholder="Add label"
                aria-label="Add label"
              />
            </form>
          </div>
        </div>

        <div className="field field--block">
          <span className="field__label">
            <ListChecks size={13} />
            Checklist {progress.total > 0 ? <em>{progress.done}/{progress.total}</em> : null}
          </span>
          {progress.total > 0 ? (
            <div className="checklist-progress">
              <div className="checklist-progress__bar" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
          ) : null}
          <div className="checklist">
            {card.checklist.map((item) => (
              <button
                className={item.done ? "checklist-item checklist-item--done" : "checklist-item"}
                type="button"
                key={item.id}
                onClick={() => onToggleChecklist(item.id)}
              >
                {item.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                <span>{item.text}</span>
              </button>
            ))}
            <form onSubmit={(event) => { event.preventDefault(); onAddChecklist(checklistInput); setChecklistInput(""); }}>
              <input
                value={checklistInput}
                onChange={(event) => setChecklistInput(event.target.value)}
                placeholder="Add checklist item"
                aria-label="Add checklist item"
              />
            </form>
          </div>
        </div>

        <button className="button button--danger detail-delete" type="button" onClick={onDelete}>
          <Trash2 size={15} />
          Delete card
        </button>
      </section>
    </div>
  );
}

export default App;
