"use client";

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  memo,
} from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  LoaderCircleIcon,
  WrenchIcon,
  CheckCircleIcon,
  ArrowUpIcon,
  PlusIcon,
  PanelLeftIcon,
  SearchIcon,
  MessageSquareIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useChatContext } from "@/stores/chat-context";
import { useVocalStore } from "@/stores/vocal";
import { RichContent } from "@/components/ui-blocks";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/chat";
import {
  type ChatPopoverOffset,
  ZERO_OFFSET,
  clampOffset,
  isDragged,
  loadOffset,
  saveOffset,
} from "@/lib/chat-popover-position";

interface ChatPopoverProps {
  /** Open state. ChatPopover is fully controlled now -- the dock button
      lives outside this component and toggles `open` via onOpenChange.
      Previously we used Radix Dialog.Trigger which produced a stuck
      "click dock to close" bug while busy: the trigger only opens, and
      our onInteractOutside guard (needed to suppress close-then-reopen
      on the trigger click) blocked the close path entirely. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ConversationMeta {
  id: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

const SIDEBAR_WIDTH = 220;
const CHAT_WIDTH = 380;

/**
 * The chat surface as a bottom-centered popup that rises from the bottom
 * edge. Frosted-glass card sitting on top of the canvas (modal={false} --
 * no scroll lock, no overlay, the OS stays interactive). One signature
 * detail: an aurora behind the input bar that intensifies on focus and
 * breathes while the agent is responding.
 *
 * History/sessions live in a slide-out sidebar inside the popup. Closed by
 * default to keep the surface tight; toggled via the panel button in the
 * header. When open, the popup expands symmetrically (centering preserved)
 * to reveal the sessions list.
 */
export function ChatPopover({
  open,
  onOpenChange: setOpen,
}: ChatPopoverProps) {
  const chat = useChatContext();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevBusyRef = useRef(false);
  // Latches when the user explicitly closes the popup during a busy
  // session. Suppresses subsequent auto-opens until the agent fully
  // settles to idle. Without this, the queue-drain false->true busy
  // flicker (useChatState lines 113-134) re-fires the rising-edge
  // auto-open below and snaps the popup back open after every close.
  const userClosedDuringBusyRef = useRef(false);

  // Drag-to-move state. `offset` is an additional translate applied on top of
  // the bottom-center anchor; persisted to localStorage so the popup reopens
  // where the user left it. offsetRef mirrors it for event handlers that must
  // read the latest value without re-subscribing window listeners.
  const [offset, setOffset] = useState<ChatPopoverOffset>(() => loadOffset());
  const offsetRef = useRef(offset);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  // Scroll-to-bottom ref callback: fires the moment the scroll container
  // is attached to the DOM, which is before the entrance animation starts
  // and before any paint. This is what guarantees the popup opens pinned
  // to the most recent message -- useEffect alone missed it because the
  // scrollHeight was read before the list had fully laid out.
  const attachScrollRef = (el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const lastContent = chat?.messages[chat.messages.length - 1]?.content;
  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, chat?.messages.length, lastContent]);

  // Rising-edge auto-open: open the popup only on the transition
  // busy:false -> busy:true. Do NOT depend on `open` here -- if the user
  // closes while the agent is still busy, we respect that and don't
  // reopen (which would trap them inside the popup until streaming ends).
  // The userClosedDuringBusyRef latch makes that respect stick across
  // queue-drain flickers within the same busy session.
  //
  // Suppressed when Aoede is active: vocal delegates via submitMessage,
  // which flips busy and would otherwise snap the chat open on top of the
  // vocal overlay. The delegation banner inside VocalPanel already
  // surfaces the build; the chat popup would be noise.
  const busy = chat?.busy ?? false;
  const vocalActive = useVocalStore((s) => s.active);
  useEffect(() => {
    // Once the agent is fully idle, re-arm auto-open for the next run.
    if (!busy) userClosedDuringBusyRef.current = false;
    if (
      busy &&
      !prevBusyRef.current &&
      !userClosedDuringBusyRef.current &&
      !vocalActive
    ) {
      // react-doctor-disable-next-line react-doctor/no-prop-callback-in-effect -- not state mirroring: this is an imperative "open the chat" command fired only on the busy false->true rising edge (guarded by prevBusyRef + the userClosedDuringBusyRef latch). `open` is genuinely owned by the parent controlled component; lifting it further would not change that this must trigger on a busy edge, equivalent to firing from an event.
      setOpen(true);
    }
    prevBusyRef.current = busy;
  }, [busy, vocalActive, setOpen]);

  // Wrap setOpen so every close path latches userClosedDuringBusyRef
  // when the user dismisses while the agent is still busy. Used by both
  // the Base UI Dialog (Esc, click outside) and the header X button.
  const handleOpenChange = (next: boolean) => {
    if (!next && busy) userClosedDuringBusyRef.current = true;
    setOpen(next);
  };

  const handleDialogOpenChange = (
    next: boolean,
    eventDetails: DialogPrimitive.Root.ChangeEventDetails,
  ) => {
    if (!next && eventDetails.reason === "escape-key" && chat?.busy) {
      eventDetails.cancel();
      chat.abortCurrent();
      return;
    }
    handleOpenChange(next);
  };

  // Clamp an offset against the live popup size + viewport so the surface can
  // never be dragged off-screen. Reads refs/window at call time, so a stale
  // closure inside event handlers is harmless.
  const clampToViewport = (next: ChatPopoverOffset): ChatPopoverOffset => {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return next;
    return clampOffset(
      next,
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height },
    );
  };

  const applyOffset = (next: ChatPopoverOffset) => {
    offsetRef.current = next;
    setOffset(next);
  };

  const handleDragStart = (event: React.PointerEvent<HTMLElement>) => {
    // Don't start a drag from interactive header controls.
    const target = event.target as HTMLElement;
    if (target.closest("button,a,input,textarea,select,[role='combobox']")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  // Double-click the header to snap the popup back to its bottom-center home.
  const handleResetPosition = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,a,input,textarea,select")) return;
    applyOffset({ ...ZERO_OFFSET });
    saveOffset(ZERO_OFFSET);
  };

  // Window-level pointer + resize listeners. Mounted once; the move/up
  // handlers no-op until a drag is in flight (dragRef set by handleDragStart).
  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      applyOffset(
        clampToViewport({
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY,
        }),
      );
    };
    const handleUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      saveOffset(offsetRef.current);
    };
    const handleResize = () => {
      if (!isDragged(offsetRef.current)) return;
      applyOffset(clampToViewport(offsetRef.current));
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      window.removeEventListener("resize", handleResize);
    };
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- handlers read live values via refs (dragRef/offsetRef/contentRef) and window; the listener set is mounted once for the component's lifetime and must not re-subscribe on every offset change.
  }, []);

  const handleSwitchConversation = (id: string) => {
    chat?.switchConversation(id);
    setSidebarOpen(false);
  };

  const handleNewChat = async () => {
    await chat?.newChat();
    setSidebarOpen(false);
  };

  // No chat context yet -- render nothing. The dock button still exists
  // and will be a no-op until ChatProvider mounts.
  if (!chat) return null;

  const popupWidth = sidebarOpen
    ? `min(${SIDEBAR_WIDTH + CHAT_WIDTH}px, calc(100vw - 32px))`
    : `min(${CHAT_WIDTH}px, calc(100vw - 32px))`;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={handleDialogOpenChange}
      modal={false}
      disablePointerDismissal
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          className={cn(
            // Bottom-centered. left-1/2 + the keyframe-baked translateX(-50%)
            // keep horizontal centering coherent with the open/close
            // animations, which also drive Y / scale transforms.
            "fixed bottom-5 left-1/2 z-[60]",
            "flex overflow-hidden",
            "rounded-2xl border border-border/50",
            // Mostly opaque card so backdrop-blur can stay light. Heavier
            // blur was repainting on every text-stream chunk and causing
            // visible flicker; md blur gives the "glassy" hint at a
            // fraction of the per-frame cost.
            "bg-card/94 backdrop-blur-md backdrop-saturate-150",
            // Subtle layered shadow: short contact + soft ambient + a
            // hairline of accent bloom. Restrained on purpose.
            "shadow-[0_2px_8px_-2px_rgba(0,0,0,0.08),0_20px_40px_-12px_rgba(0,0,0,0.18),0_0_60px_-30px_var(--primary)]",
            "data-open:animate-[chat-popup-in_360ms_cubic-bezier(0.22,1,0.36,1)_both]",
            "data-closed:animate-[chat-popup-out_180ms_ease-in_both]",
            "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            // transform-gpu promotes the popup to its own compositor layer
            // so streaming text below doesn't repaint the whole surface.
            "transform-gpu",
          )}
          style={{
            height: "min(56vh, 460px)",
            width: popupWidth,
            transformOrigin: "bottom center",
            // Drag offset rides the independent `translate` property so it
            // composes with the keyframe `transform` (which bakes in the
            // -50% centering + open/close animation) instead of fighting it.
            translate: isDragged(offset) ? `${offset.x}px ${offset.y}px` : undefined,
            // react-doctor-disable-next-line react-doctor/no-permanent-will-change -- intentional ambient GPU promotion: this popover surface only mounts while open, animates on open/close + width transitions, and is deliberately layer-promoted (see transform-gpu above) so streaming text below does not repaint the whole surface; toggling will-change per-animation here would reintroduce the streaming flicker this optimization fixes.
            willChange: "transform, opacity",
          }}
          aria-describedby={undefined}
          ref={contentRef}
          data-testid="chat-popover"
        >
          <DialogPrimitive.Title className="sr-only">Hermes</DialogPrimitive.Title>

          <SessionsSidebar
            open={sidebarOpen}
            conversations={chat.conversations}
            currentSessionId={chat.sessionId}
            onSelect={handleSwitchConversation}
            onNewChat={handleNewChat}
            onClose={() => setSidebarOpen(false)}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <ChatHeader
              busy={chat.busy}
              connected={chat.connected}
              queuedCount={chat.queue.length}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
              onNewChat={handleNewChat}
              onClose={() => handleOpenChange(false)}
              onDragStart={handleDragStart}
              onResetPosition={handleResetPosition}
            />
            <ChatMessages
              messages={chat.messages}
              busy={chat.busy}
              onAction={chat.submitMessage}
              attachScrollRef={attachScrollRef}
            />
            <ChatInputBar
              onSubmit={chat.submitMessage}
              onAbort={chat.abortCurrent}
              busy={chat.busy}
            />
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function groupConversationsByTime(conversations: ConversationMeta[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const yesterdayMs = todayMs - 86_400_000;
  const weekMs = todayMs - 7 * 86_400_000;

  const groups: { label: string; items: ConversationMeta[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];

  const sorted = conversations.toSorted((a, b) => b.updatedAt - a.updatedAt);
  for (const conv of sorted) {
    if (conv.updatedAt >= todayMs) groups[0].items.push(conv);
    else if (conv.updatedAt >= yesterdayMs) groups[1].items.push(conv);
    else if (conv.updatedAt >= weekMs) groups[2].items.push(conv);
    else groups[3].items.push(conv);
  }
  return groups.filter((g) => g.items.length > 0);
}

function SessionsSidebar({
  open,
  conversations,
  currentSessionId,
  onSelect,
  onNewChat,
  onClose,
}: {
  open: boolean;
  conversations: ConversationMeta[];
  currentSessionId: string | undefined;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");

  const trimmedQuery = query.trim();
  const filtered = !trimmedQuery
    ? conversations
    : conversations.filter((c) =>
        c.preview?.toLowerCase().includes(query.toLowerCase()),
      );

  const timeGroups = groupConversationsByTime(filtered);

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-border/50 bg-muted/40 transition-all duration-300",
        "ease-[cubic-bezier(0.22,1,0.36,1)]",
        open ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      style={{
        width: open ? SIDEBAR_WIDTH : 0,
        overflow: "hidden",
      }}
      aria-hidden={!open}
    >
      <div className="flex shrink-0 items-center justify-between gap-1 px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          title="Hide history"
          aria-label="Hide history"
        >
          <PanelLeftIcon className="size-3" />
        </button>
        <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          History
        </span>
        <button
          type="button"
          onClick={onNewChat}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          title="New chat"
          aria-label="New chat"
        >
          <PlusIcon className="size-3" />
        </button>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border/40 bg-background/60 px-2 py-1">
          <SearchIcon className="size-2.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search conversations"
            className="flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/55"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {timeGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
            <MessageSquareIcon className="size-4 text-muted-foreground/40" />
            <p className="text-[10px] text-muted-foreground/60">
              {query ? "Nothing matches" : "No conversations yet"}
            </p>
          </div>
        ) : (
          timeGroups.map((group) => (
            <div key={group.label}>
              <div className="px-2 pt-3 pb-1 text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {group.label}
              </div>
              {group.items.map((conv) => {
                const active = conv.id === currentSessionId;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => onSelect(conv.id)}
                    className={cn(
                      "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <span className="flex-1 truncate">
                      {conv.preview?.trim()
                        ? conv.preview.slice(0, 44) +
                          (conv.preview.length > 44 ? "…" : "")
                        : "New chat"}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// React Compiler memoizes this component's output and the parent's JSX,
// so streaming text deltas (which only update messages) don't re-render
// the header — its tracked inputs (busy / queue / sidebar) are unchanged.
function ChatHeader({
  busy,
  connected,
  queuedCount,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  onClose,
  onDragStart,
  onResetPosition,
}: {
  busy: boolean;
  connected: boolean;
  queuedCount: number;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  onClose: () => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>) => void;
  onResetPosition: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    // The header doubles as the drag handle (pointer-down anywhere that isn't
    // a control moves the popup; double-click snaps it home). touch-none keeps
    // a touch drag from scrolling the page underneath.
    <div
      className="flex shrink-0 cursor-grab touch-none select-none items-center justify-between border-b border-border/30 px-2.5 py-2 active:cursor-grabbing"
      onPointerDown={onDragStart}
      onDoubleClick={onResetPosition}
      data-testid="chat-popover-drag-handle"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleSidebar}
          className={cn(
            "flex size-6 items-center justify-center rounded-md transition-colors",
            sidebarOpen
              ? "bg-accent text-foreground"
              : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
          )}
          title={sidebarOpen ? "Hide history" : "Show history"}
          aria-label="Toggle history"
        >
          <PanelLeftIcon className="size-3" />
        </button>
        <span
          className={cn(
            "ml-1.5 size-1 rounded-full transition-colors",
            busy
              ? "animate-pulse bg-primary shadow-[0_0_6px_var(--primary)]"
              : connected
                ? "bg-emerald-500/70"
                : "bg-muted-foreground/30",
          )}
          aria-hidden
        />
        <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground/80">
          {busy ? "Responding" : connected ? "Listening" : "Offline"}
          {queuedCount > 0 && (
            <span className="ml-1.5 text-primary">· {queuedCount} queued</span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onNewChat}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          title="New conversation"
          aria-label="New conversation"
        >
          <PlusIcon className="size-3" />
        </button>
        {/* esc keycap makes the keyboard close path discoverable; the X is
            the unambiguous click target. */}
        <kbd className="hidden h-5 select-none items-center rounded border border-border/50 bg-muted/50 px-1.5 font-mono text-[9px] tracking-wider text-muted-foreground/70 sm:flex">
          esc
        </kbd>
        <button
          type="button"
          onClick={onClose}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          title="Close (Esc)"
          aria-label="Close"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// Per-message memoization. A re-render only fires when this message's
// content/tool/role or the global busy flag actually change. Without
// this, every text delta re-rendered every prior message — which meant
// re-running Streamdown's markdown parse on the entire chat history.
// react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing memo bailout for list items: rows are rendered inside a .map(), and the custom comparator relies on reduceChat preserving the referential identity of settled message objects (prev.msg !== next.msg) plus busy-gating the in-flight tool spinner. This skips re-running Streamdown's O(content_length) markdown parse for the entire chat history on every streaming delta; the compiler's per-array memoization does not provide this per-element bailout.
const MessageItem = memo(function MessageItem({
  msg,
  busy,
  onAction,
}: {
  msg: ChatMessage;
  busy: boolean;
  onAction: (text: string) => void;
}) {
  return (
    <li>
      {msg.role === "user" ? (
        <div className="flex justify-end">
          <div className="max-w-[82%] rounded-[14px] rounded-tr-sm bg-secondary px-3 py-1.5 text-[13px] leading-snug text-secondary-foreground">
            {msg.content}
          </div>
        </div>
      ) : msg.tool ? (
        <div className="flex items-center gap-1.5 py-0.5 text-[10px] text-muted-foreground/80">
          <WrenchIcon className="size-2.5" />
          <span className="font-mono">{msg.tool}</span>
          {/* Only spin when the agent is still busy. Without the busy
              gate, an in-flight tool message ("Using X...") would spin
              forever after Stop because the server never emits tool_end
              on abort, and a tool_start that races past the abort can
              sneak a new "Using X" into history. */}
          {msg.content.startsWith("Using ") && busy ? (
            <LoaderCircleIcon className="size-2.5 animate-spin" />
          ) : (
            <CheckCircleIcon className="size-2.5 text-emerald-500/70" />
          )}
        </div>
      ) : msg.role === "system" ? (
        <div className="py-0.5 text-[10px] text-muted-foreground/60">
          {msg.content}
        </div>
      ) : (
        // Scope Streamdown's defaults to the popup so prose stays
        // cohesive: strong stays in foreground tone (no terracotta
        // shock), code becomes a small chip, links keep the accent.
        <div
          className={cn(
            "text-[13px] leading-relaxed text-foreground",
            "[&_strong]:text-foreground [&_strong]:font-semibold",
            "[&_code]:rounded [&_code]:border [&_code]:border-border/40 [&_code]:bg-muted/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.82em] [&_code]:text-foreground",
            "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
            "[&_ul]:my-1 [&_ul]:space-y-0.5 [&_ol]:my-1 [&_ol]:space-y-0.5",
            "[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
          )}
        >
          <RichContent onAction={onAction}>{msg.content}</RichContent>
        </div>
      )}
    </li>
  );
}, (prev, next) => {
  // Custom equality: skip re-render unless the actual user-visible state
  // for this row changed. msg.id equality alone isn't enough because
  // streaming mutates msg.content in place via reduceChat returning a
  // new array. The busy comparison only matters for in-flight tool rows
  // (where the spinner depends on it) -- everything else is content-only.
  if (prev.msg !== next.msg) return false;
  if (prev.onAction !== next.onAction) return false;
  // For rows that don't render the spinner, busy is irrelevant.
  const isToolRow = !!next.msg.tool;
  if (isToolRow && prev.busy !== next.busy) return false;
  return true;
});

function ChatMessages({
  messages,
  busy,
  onAction,
  attachScrollRef,
}: {
  messages: ChatMessage[];
  busy: boolean;
  onAction: (text: string) => void;
  attachScrollRef: (el: HTMLDivElement | null) => void;
}) {
  const visibleMessages = messages.filter(
    (m) => m.role !== "system" || m.content.trim(),
  );

  if (visibleMessages.length === 0 && !busy) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
        <p className="text-[13px] font-light text-foreground">What are we doing?</p>
        <p className="text-[11px] text-muted-foreground/70">Ask anything. Build anything.</p>
      </div>
    );
  }

  return (
    // ph-no-capture: chat transcripts are private user/agent conversations;
    // PostHog session replay blocks this element natively.
    <div ref={attachScrollRef} className="ph-no-capture flex-1 overflow-y-auto px-3.5 py-3">
      <ul className="flex flex-col gap-2.5">
        {visibleMessages.map((msg) => (
          // MessageItem is memoized below: settled messages don't re-render
          // when a sibling streams. Without this, every text delta re-parsed
          // markdown for every assistant message in history (Streamdown is
          // O(content_length) per render) and the keystroke handler ended
          // up sharing a frame budget with that work, producing visible
          // typing lag during long agent responses.
          <MessageItem key={msg.id} msg={msg} busy={busy} onAction={onAction} />
        ))}
        {busy && visibleMessages.length === 0 && (
          <li className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" />
            <span>Thinking...</span>
          </li>
        )}
      </ul>
    </div>
  );
}

// React Compiler memoizes this component and the parent's JSX, so
// streaming text deltas don't re-render the input bar (and its aurora
// gradient + style recompute): its tracked props (onSubmit/onAbort/busy)
// are stable across deltas and busy only flips on transitions.
function ChatInputBar({
  onSubmit,
  onAbort,
  busy,
}: {
  onSubmit: (text: string) => void;
  onAbort: () => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [queuedFlash, setQueuedFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
    inputRef.current?.focus();
    // If we submitted while the agent was busy, the message went into
    // the queue rather than being sent immediately. Pulse the input
    // border so the user sees their input was acknowledged (not lost).
    if (busy) {
      setQueuedFlash(true);
      setTimeout(() => setQueuedFlash(false), 450);
    }
  };

  // The aurora's intensity tracks the conversation's energy. Restrained
  // opacity values keep it a hint of light, never a distraction.
  const auroraOpacity = busy ? "opacity-40" : focused ? "opacity-25" : "opacity-10";
  const auroraAnimation = busy
    ? "chat-aurora-spin 12s linear infinite, chat-aurora-breathe 2.4s ease-in-out infinite"
    : focused
      ? "chat-aurora-spin 24s linear infinite"
      : "chat-aurora-spin 60s linear infinite";

  return (
    <div className="relative shrink-0 border-t border-border/30">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-6 -top-4 bottom-1.5 rounded-full transition-opacity duration-700",
          auroraOpacity,
        )}
        style={{
          background:
            "conic-gradient(from 180deg at 50% 50%, var(--primary), #7c3aed, #06b6d4, var(--primary))",
          // react-doctor-disable-next-line react-doctor/no-large-animated-blur -- intentionally ambient decorative aurora bloom behind the input; the soft 36px radius is the visual effect itself and clamping to <10px would collapse the glow into a hard ring, changing the designed appearance. Element is pointer-events-none, single-layer, and only animates opacity.
          filter: "blur(36px)",
          animation: auroraAnimation,
        }}
      />
      <form
        onSubmit={handleSubmit}
        className="relative flex items-center gap-2.5 px-3.5 py-2.5"
        // Pulse the form border (which wraps input + button) when the user
        // queues a message while busy. Confirms the queue acknowledged
        // their input even though the agent is mid-response.
        style={{
          animation: queuedFlash
            ? "chat-input-queued-flash 450ms ease-out"
            : undefined,
          borderRadius: "12px",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={busy ? "Queue another message…" : "What do you want to say?"}
          aria-label="Chat message"
          // react-doctor-disable-next-line react-doctor/no-autofocus -- chat input inside a dialog popover that mounts only when the user opens it; focus is essential so they can type immediately
          autoFocus
          className={cn(
            "flex-1 bg-transparent text-sm text-foreground outline-none",
            "placeholder:font-light placeholder:text-muted-foreground/55",
          )}
          style={{ letterSpacing: "-0.005em" }}
        />
        {busy ? (
          // Stop button: red square. Replaces send during a busy run so
          // there's always a visible way to halt the agent. Esc also
          // works (see Dialog.onEscapeKeyDown above).
          <button
            type="button"
            onClick={onAbort}
            className={cn(
              "flex size-7 items-center justify-center rounded-full transition-all",
              "bg-destructive text-white shadow-[0_2px_8px_-2px_var(--destructive)]",
              "hover:scale-[1.04] active:scale-95",
            )}
            aria-label="Stop"
            title="Stop (Esc)"
          >
            <SquareIcon className="size-3" strokeWidth={0} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim()}
            className={cn(
              "flex size-7 items-center justify-center rounded-full transition-all",
              "bg-primary text-primary-foreground shadow-[0_2px_8px_-2px_var(--primary)]",
              "hover:scale-[1.04] active:scale-95",
              "disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100",
            )}
            aria-label="Send"
          >
            <ArrowUpIcon className="size-3.5" strokeWidth={2.4} />
          </button>
        )}
      </form>
    </div>
  );
}
