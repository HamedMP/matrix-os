/**
 * The virtualised conversation list (an ARIA grid: each row holds a select
 * checkbox and the summary) with multi-select, shift-click ranges, drag to
 * folders and paging near the end. Keyboard commands come from the
 * workspace's key handler.
 */
import { useCallback, useEffect, type DragEvent, type MouseEvent } from "react";
import { Spinner } from "../../../_shared/office-ui";
import { selectActiveView, selectHasMore, selectIsTriagePending, type MailState, type ThreadKey } from "../model";
import { useMailUi } from "./context";
import { encodeThreadDrag, THREAD_DRAG_TYPE } from "./drag";
import { EmptyList, StaleListNotice } from "./ListStates";
import { THREAD_ROW_HEIGHT, ThreadRow } from "./ThreadRow";
import { useViewport } from "./use-viewport";

const OVERSCAN = 6;
/** Rows from the end at which the next page is requested. */
const LOAD_MORE_ROWS = 10;

export interface ThreadListProps {
  state: MailState;
  keys: readonly ThreadKey[];
}

/** Row interaction handlers bound to the store. */
function useRowHandlers(selectionKeys: readonly ThreadKey[]) {
  const { store, dragKeys } = useMailUi();
  const onRowClick = useCallback((key: ThreadKey, event: MouseEvent) => {
    if (event.shiftKey) store.selectRangeTo(key);
    else if (event.metaKey || event.ctrlKey) store.toggleSelect(key);
    else {
      store.focus(key);
      void store.openThread(key);
    }
  }, [store]);
  const onCheck = useCallback((key: ThreadKey, shift: boolean) => {
    if (shift) store.selectRangeTo(key);
    else store.toggleSelect(key);
  }, [store]);
  const onDragStart = useCallback((key: ThreadKey, event: DragEvent) => {
    const dragged = selectionKeys.includes(key) ? [...selectionKeys] : [key];
    dragKeys.current = dragged;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(THREAD_DRAG_TYPE, encodeThreadDrag(dragged));
  }, [dragKeys, selectionKeys]);
  const onDragEnd = useCallback(() => {
    dragKeys.current = [];
  }, [dragKeys]);
  return { onRowClick, onCheck, onDragStart, onDragEnd };
}

export function ThreadList({ state, keys }: ThreadListProps) {
  const { store, now, timeZone, ownAddresses } = useMailUi();
  const view = selectActiveView(state);
  const hasMore = selectHasMore(state);
  const focusedIndex = state.focused ? keys.indexOf(state.focused) : -1;
  const viewport = useViewport(THREAD_ROW_HEIGHT, focusedIndex);
  const handlers = useRowHandlers(state.selection.keys);

  const start = Math.max(0, Math.floor(viewport.scrollTop / THREAD_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(keys.length, Math.ceil((viewport.scrollTop + viewport.height) / THREAD_ROW_HEIGHT) + OVERSCAN);
  const canLoadMore = hasMore && view !== undefined && !view.loadingMore && view.status !== "loading" && keys.length > 0;
  const nearEnd = end >= keys.length - LOAD_MORE_ROWS;

  useEffect(() => {
    if (canLoadMore && nearEnd) void store.loadMore();
  }, [canLoadMore, nearEnd, store]);

  if (!view) return null;
  if (keys.length === 0) return <EmptyList state={state} view={view} />;

  const selected = new Set(state.selection.keys);
  const openKey = state.openThread?.key ?? null;
  const clock = now();
  const rows = keys.slice(start, end).flatMap((key, offset) => {
    const summary = state.threads[key];
    if (!summary) return [];
    return [(
      <ThreadRow
        key={key}
        threadKey={key}
        summary={summary}
        index={start + offset}
        selected={selected.has(key)}
        focused={key === state.focused}
        open={key === openKey}
        pending={selectIsTriagePending(state, key)}
        now={clock}
        timeZone={timeZone}
        ownAddresses={ownAddresses}
        {...handlers}
      />
    )];
  });

  return (
    <div className="mail-list-wrap">
      <StaleListNotice view={view} />
      <div
        ref={viewport.ref}
        className="mail-list"
        role="grid"
        aria-label="Conversations"
        aria-multiselectable="true"
        aria-rowcount={keys.length}
        aria-activedescendant={focusedIndex >= start && focusedIndex < end ? `mail-row-${focusedIndex}` : undefined}
        aria-busy={view.status === "loading" || undefined}
        tabIndex={0}
        onScroll={viewport.onScroll}
      >
        <div className="mail-list__canvas" role="presentation" style={{ height: keys.length * THREAD_ROW_HEIGHT }}>{rows}</div>
      </div>
      {view.loadingMore && <div className="mail-list__more"><Spinner size={14} label="Loading more conversations" /></div>}
    </div>
  );
}
