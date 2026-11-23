/**
 * The virtualised conversation list with multi-select, shift-click ranges,
 * drag to folders, paging near the end and per-pane loading, empty and error
 * states. Keyboard commands come from the workspace's key handler.
 */
import { useCallback, useEffect, useState, type DragEvent, type MouseEvent } from "react";
import { AlertCircle, Inbox, SearchX } from "lucide-react";
import { EmptyState, Skeleton, Spinner } from "../../../_shared/office-ui";
import { selectActiveView, selectHasMore, selectIsTriagePending, type MailState, type ThreadKey } from "../model";
import { useMailUi } from "./context";
import { encodeThreadDrag, THREAD_DRAG_TYPE } from "./drag";
import { THREAD_ROW_HEIGHT, ThreadRow } from "./ThreadRow";

const OVERSCAN = 6;
const FALLBACK_HEIGHT = 600;
/** Rows from the end at which the next page is requested. */
const LOAD_MORE_ROWS = 10;

export interface ThreadListProps {
  state: MailState;
  keys: readonly ThreadKey[];
}

function ListSkeleton() {
  return (
    <div className="mail-list__skeleton" aria-busy="true" aria-label="Loading conversations">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="mail-row-skeleton"><Skeleton width="40%" /><Skeleton width="85%" /><Skeleton width="65%" /></div>
      ))}
    </div>
  );
}

export function ThreadList({ state, keys }: ThreadListProps) {
  const { store, now, timeZone, ownAddresses, dragKeys } = useMailUi();
  // A callback ref: the viewport mounts only once there are rows.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const view = selectActiveView(state);
  const hasMore = selectHasMore(state);
  const clock = now();

  useEffect(() => {
    const el = viewport;
    if (!el) return undefined;
    const update = () => {
      if (el.clientHeight > 0) setHeight(el.clientHeight);
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewport]);

  // Keep the focused row in view when the keyboard moves it.
  const focusedIndex = state.focused ? keys.indexOf(state.focused) : -1;
  useEffect(() => {
    const el = viewport;
    if (!el || focusedIndex < 0) return;
    const top = focusedIndex * THREAD_ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + THREAD_ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + THREAD_ROW_HEIGHT - el.clientHeight;
  }, [focusedIndex, viewport]);

  const start = Math.max(0, Math.floor(scrollTop / THREAD_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(keys.length, Math.ceil((scrollTop + height) / THREAD_ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    if (hasMore && view && !view.loadingMore && view.status !== "loading" && keys.length > 0 && end >= keys.length - LOAD_MORE_ROWS) {
      void store.loadMore();
    }
  }, [end, hasMore, keys.length, store, view]);

  const onRowClick = useCallback((key: ThreadKey, event: MouseEvent) => {
    if (event.shiftKey) {
      store.selectRangeTo(key);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      store.toggleSelect(key);
      return;
    }
    store.focus(key);
    void store.openThread(key);
  }, [store]);

  const onCheck = useCallback((key: ThreadKey, shift: boolean) => {
    if (shift) store.selectRangeTo(key);
    else store.toggleSelect(key);
  }, [store]);

  const selectionKeys = state.selection.keys;
  const onDragStart = useCallback((key: ThreadKey, event: DragEvent) => {
    const dragged = selectionKeys.includes(key) ? [...selectionKeys] : [key];
    dragKeys.current = dragged;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(THREAD_DRAG_TYPE, encodeThreadDrag(dragged));
  }, [dragKeys, selectionKeys]);
  const onDragEnd = useCallback(() => {
    dragKeys.current = [];
  }, [dragKeys]);

  if (!view) return null;
  const searching = view.descriptor.kind === "search" || state.filter.trim().length > 0;

  if (keys.length === 0) {
    if (view.status === "loading" || (view.status === "idle" && !state.cacheLoaded)) return <ListSkeleton />;
    if (view.status === "error") {
      return (
        <div className="mail-list mail-list--state" role="alert">
          <EmptyState
            icon={<AlertCircle />}
            headline="Conversations could not be loaded"
            description={view.error?.message}
            action={{ label: "Try again", onClick: () => void store.refresh() }}
          />
        </div>
      );
    }
    return (
      <div className="mail-list mail-list--state">
        {searching
          ? <EmptyState icon={<SearchX />} headline="No matching conversations" description="Try fewer words or remove a filter." />
          : <EmptyState icon={<Inbox />} headline="Nothing here" description="New conversations in this folder appear here." />}
      </div>
    );
  }

  const selected = new Set(selectionKeys);
  const openKey = state.openThread?.key ?? null;
  const rows = [];
  for (let index = start; index < end; index += 1) {
    const key = keys[index];
    const summary = state.threads[key];
    if (!summary) continue;
    rows.push(
      <ThreadRow
        key={key}
        threadKey={key}
        summary={summary}
        index={index}
        selected={selected.has(key)}
        focused={key === state.focused}
        open={key === openKey}
        pending={selectIsTriagePending(state, key)}
        now={clock}
        timeZone={timeZone}
        ownAddresses={ownAddresses}
        onRowClick={onRowClick}
        onCheck={onCheck}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />,
    );
  }

  return (
    <div className="mail-list-wrap">
      {view.error && (
        <div className="mail-pane-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{view.error.message} Showing saved conversations.</span>
          <button type="button" className="oui-button oui-button--ghost" onClick={() => void store.refresh()}>Retry</button>
        </div>
      )}
      <div
        ref={setViewport}
        className="mail-list"
        role="listbox"
        aria-label="Conversations"
        aria-multiselectable="true"
        aria-activedescendant={focusedIndex >= start && focusedIndex < end ? `mail-row-${focusedIndex}` : undefined}
        aria-busy={view.status === "loading" || undefined}
        tabIndex={0}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div className="mail-list__canvas" style={{ height: keys.length * THREAD_ROW_HEIGHT }}>{rows}</div>
      </div>
      {view.loadingMore && <div className="mail-list__more"><Spinner size={14} label="Loading more conversations" /></div>}
    </div>
  );
}
