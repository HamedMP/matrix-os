"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MessageBoardClient } from "./client.js";
import { AutomationPanel } from "./AutomationPanel.js";
import { ChannelSidebar, type BoardSidePanel } from "./ChannelSidebar.js";
import { buildChannelTree, channelScopeLabel } from "./model.js";
import { EmptyBoard, NewThreadForm } from "./NewThreadForm.js";
import { subtleBorder, textPrimary, textTertiary } from "./presentation.js";
import { ThreadList } from "./ThreadList.js";
import { ThreadView } from "./ThreadView.js";
import { useMessageBoard } from "./use-message-board.js";

export interface MessageBoardProps {
  client: MessageBoardClient;
  initialBoard?: string;
  /** Rendered at the right of the app header, e.g. a "Prototype data" pill. */
  headerAccessory?: ReactNode;
}

type Pane = 0 | 1 | 2;
type Detail = "thread" | "new" | null;

/** Three panes when wide, two when medium, one with back navigation when narrow. */
function paneCapacity(width: number): 1 | 2 | 3 {
  if (width >= 980) return 3;
  return width >= 620 ? 2 : 1;
}

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Ticks every second while a lease countdown is on screen, otherwise every 30 seconds. */
function useClock(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

export function MessageBoard({ client, initialBoard, headerAccessory }: MessageBoardProps) {
  const board = useMessageBoard(client, initialBoard);
  const { ref, width } = useContainerWidth();
  const capacity = paneCapacity(width);
  const [panel, setPanel] = useState<BoardSidePanel | null>(null);
  const [detail, setDetail] = useState<Detail>(null);
  const [focus, setFocus] = useState<Pane>(1);

  const viewerId = board.me.data?.id ?? "";
  const actors = board.actors.data ?? [];
  const channels = board.channels.data;
  const tree = useMemo(() => buildChannelTree(channels ?? []), [channels]);
  const totalUnread = useMemo(() => (channels ?? []).reduce((sum, channel) => sum + channel.unread, 0), [channels]);
  const leaseVisible = (board.threads.data ?? []).some((thread) => thread.task?.state === "claimed");
  const nowMs = useClock(leaseVisible);
  const boardEmpty = channels !== null && channels.length === 0;
  const activeDetail: Detail = detail === "thread" && !board.selectedThreadId ? null : detail;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (panel) setPanel(null);
    };
    const node = ref.current;
    node?.addEventListener("keydown", onKey);
    return () => node?.removeEventListener("keydown", onKey);
  }, [panel, ref]);

  const openThread = (id: string) => {
    board.selectThread(id);
    setDetail("thread");
    setPanel(null);
    setFocus(2);
  };
  const closeDetail = () => { setDetail(null); board.selectThread(null); setFocus(1); };
  const startNew = () => { setDetail("new"); setPanel(null); setFocus(2); };

  const showPane = (pane: Pane) => {
    if (capacity === 3) return true;
    if (capacity === 1) return pane === focus;
    return focus === 2 ? pane >= 1 : pane <= 1;
  };
  const sidebarHidden = !showPane(0);
  // A reply that arrives while its thread is on screen is read; a hidden pane does not count.
  const shown = activeDetail === "thread" && showPane(2) ? board.thread.data : null;
  const shownLatest = shown ? `${shown.root.id}:${shown.replies.at(-1)?.id ?? ""}` : null;
  const lastShown = useRef<string | null>(null);
  const markRead = board.markRead;
  useEffect(() => {
    const previous = lastShown.current;
    lastShown.current = shownLatest;
    if (!shownLatest || !previous) return;
    const [rootId] = shownLatest.split(":");
    if (previous !== shownLatest && previous.startsWith(`${rootId}:`)) markRead(rootId!);
  }, [shownLatest, markRead]);
  const backToList = capacity < 3 ? () => setFocus(1) : undefined;
  const backToSidebar = sidebarHidden ? () => setFocus(0) : undefined;
  const defaultChannel = board.scope === "*" || board.scope.endsWith("/") ? (channels?.[0]?.path ?? "dev") : board.scope;

  const detailPane = activeDetail === "new"
    ? <NewThreadForm channels={(channels ?? []).map((channel) => channel.path)} defaultChannel={defaultChannel} actors={actors} viewerId={viewerId}
        mutate={board.mutate} onClose={closeDetail} onBack={backToList} onPosted={(message) => openThread(message.id)} />
    : activeDetail === "thread"
      ? <ThreadView thread={board.thread} viewerId={viewerId} actors={actors} nowMs={nowMs} mutate={board.mutate}
          onOpenThread={openThread} onBack={backToList} onClose={capacity === 3 ? closeDetail : undefined} onRetry={board.reload} />
      : <div className="grid h-full place-items-center px-6 text-center text-[13px]" style={textTertiary}>Select a thread to read it here.</div>;

  return <div ref={ref} data-slot="message-board" className="flex h-full min-h-0 flex-col" style={{ background: "var(--bg-app, var(--background))", color: "var(--text-primary, var(--foreground))" }}>
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3" style={subtleBorder}>
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold" style={textPrimary}>
        {board.board}
      </h1>
      {headerAccessory}
    </header>
    <div className="flex min-h-0 flex-1">
      {showPane(0) ? <div className={`${capacity === 1 ? "flex-1" : "w-56 shrink-0 border-r"} min-h-0`} style={{ ...subtleBorder, background: "var(--bg-surface, var(--card))" }}>
        <ChannelSidebar boards={board.boards.data ?? []} board={board.board} tree={tree} totalUnread={totalUnread} scope={board.scope}
          activeWatchers={(board.watchers.data ?? []).filter((watcher) => watcher.enabled).length}
          activeSchedules={(board.schedules.data ?? []).length} panel={panel}
          onSelectBoard={(name) => { board.selectBoard(name); setDetail(null); setPanel(null); setFocus(1); }}
          onSelectScope={(scope) => { board.selectScope(scope); setDetail(null); setPanel(null); setFocus(1); }}
          onOpenPanel={(next) => { setPanel(next); setDetail(null); board.selectThread(null); setFocus(1); }} />
      </div> : null}
      {panel && (showPane(1) || showPane(2))
        ? <div className="min-h-0 min-w-0 flex-1">
            <AutomationPanel panel={panel} watchers={board.watchers} schedules={board.schedules} viewerId={viewerId} nowMs={nowMs}
              mutate={board.mutate} onClose={() => setPanel(null)} onBack={backToSidebar} onOpenThread={openThread} />
          </div>
        : boardEmpty && activeDetail !== "new" && (showPane(1) || showPane(2))
          ? <div className="min-h-0 min-w-0 flex-1"><EmptyBoard boardName={board.board} onPost={startNew} onBack={backToSidebar} /></div>
          : <>
              {showPane(1) ? <div className={`${!showPane(2) ? "flex-1" : capacity === 3 ? "w-[22rem] shrink-0 border-r" : "w-[45%] shrink-0 border-r"} min-h-0 min-w-0`} style={subtleBorder}>
                <ThreadList title={channelScopeLabel(board.scope)} threads={board.threads.data} status={board.threads.status} error={board.threads.error}
                  mode={board.mode} filter={board.filter} limit={board.limit} onShowMore={board.showMore} actors={actors} viewerId={viewerId} nowMs={nowMs} selectedId={activeDetail === "thread" ? board.selectedThreadId : null}
                  showScope={board.scope === "*" || board.scope.endsWith("/")}
                  onModeChange={board.setMode} onFilterChange={board.setFilter}
                  onSelect={openThread} onNewThread={startNew} onRetry={board.reload} onBack={backToSidebar} />
              </div> : null}
              {showPane(2) ? <div className="min-h-0 min-w-0 flex-1" style={{ background: "var(--bg-surface, var(--card))" }}>{detailPane}</div> : null}
            </>}
    </div>
  </div>;
}
