"use client";

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  memo,
} from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
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
} from "lucide-react";
import { useChatContext } from "@/stores/chat-context";
import { RichContent } from "@/components/ui-blocks";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/chat";

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

  // Scroll-to-bottom ref callback: fires the moment the scroll container
  // is attached to the DOM, which is before the entrance animation starts
  // and before any paint. This is what guarantees the popup opens pinned
  // to the most recent message -- useEffect alone missed it because the
  // scrollHeight was read before the list had fully laid out.
  const attachScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

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
  const busy = chat?.busy ?? false;
  useEffect(() => {
    // Once the agent is fully idle, re-arm auto-open for the next run
    // (e.g. vocal mode delegating a fresh task to the chat agent).
    if (!busy) userClosedDuringBusyRef.current = false;
    if (busy && !prevBusyRef.current && !userClosedDuringBusyRef.current) {
      setOpen(true);
    }
    prevBusyRef.current = busy;
  }, [busy, setOpen]);

  // Wrap setOpen so every close path latches userClosedDuringBusyRef
  // when the user dismisses while the agent is still busy. Used by both
  // the Radix Dialog (Esc, click outside) and the header X button.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && busy) userClosedDuringBusyRef.current = true;
      setOpen(next);
    },
    [busy, setOpen],
  );

  const handleSwitchConversation = useCallback(
    (id: string) => {
      chat?.switchConversation(id);
      setSidebarOpen(false);
    },
    [chat],
  );

  const handleNewChat = useCallback(async () => {
    await chat?.newChat();
    setSidebarOpen(false);
  }, [chat]);

  // No chat context yet -- render nothing. The dock button still exists
  // and will be a no-op until ChatProvider mounts.
  if (!chat) return null;

  const popupWidth = sidebarOpen
    ? `min(${SIDEBAR_WIDTH + CHAT_WIDTH}px, calc(100vw - 32px))`
    : `min(${CHAT_WIDTH}px, calc(100vw - 32px))`;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          // Don't auto-close from "click outside" -- the dock-chat button
          // (the toggle source) is outside Content, so any click on it
          // would otherwise dismiss-then-toggle. Toggle is now driven
          // entirely by the parent via the `open` prop.
          onInteractOutside={(e) => e.preventDefault()}
          // Never auto-close from focus changes. When the user submits, the
          // input flips to disabled, browser strips focus, focus lands on
          // <body>, and Radix would interpret that as "interacted outside"
          // and close us. The rising-edge auto-open would then reopen,
          // producing a visible close->open flash on every message.
          onFocusOutside={(e) => e.preventDefault()}
          // Esc-while-busy stops the agent (popup stays open). Esc-while-
          // idle falls through to Radix's default close. This matches the
          // terminal convention "Ctrl+C to interrupt" with a more
          // discoverable key on a UI surface.
          onEscapeKeyDown={(e) => {
            if (chat.busy) {
              e.preventDefault();
              chat.abortCurrent();
            }
          }}
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
            "data-[state=open]:animate-[chat-popup-in_360ms_cubic-bezier(0.22,1,0.36,1)_both]",
            "data-[state=closed]:animate-[chat-popup-out_180ms_ease-in_both]",
            "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            // transform-gpu promotes the popup to its own compositor layer
            // so streaming text below doesn't repaint the whole surface.
            "transform-gpu",
          )}
          style={{
            height: "min(56vh, 460px)",
            width: popupWidth,
            transformOrigin: "bottom center",
            willChange: "transform, opacity",
          }}
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">Chat</DialogPrimitive.Title>

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
        </DialogPrimitive.Content>
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

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
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

  const filtered = useMemo(() => {
    if (!query.trim()) return conversations;
    const q = query.toLowerCase();
    return conversations.filter((c) => c.preview?.toLowerCase().includes(q));
  }, [conversations, query]);

  const timeGroups = useMemo(() => groupConversationsByTime(filtered), [filtered]);

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

// Memoized so streaming text deltas (which only update messages) don't
// re-render the header every tick. Props change only on busy / queue
// transitions or sidebar toggle.
const ChatHeader = memo(function ChatHeader({
  busy,
  connected,
  queuedCount,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  onClose,
}: {
  busy: boolean;
  connected: boolean;
  queuedCount: number;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/30 px-2.5 py-2">
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
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 items-center justify-center rounded-md px-1.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          title="Close (Esc)"
          aria-label="Close"
        >
          <span className="font-mono text-[9px] tracking-wider">esc</span>
        </button>
      </div>
    </div>
  );
});

// Per-message memoization. A re-render only fires when this message's
// content/tool/role or the global busy flag actually change. Without
// this, every text delta re-rendered every prior message — which meant
// re-running Streamdown's markdown parse on the entire chat history.
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
  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== "system" || m.content.trim()),
    [messages],
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
    <div ref={attachScrollRef} className="flex-1 overflow-y-auto px-3.5 py-3">
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

// Memoized so streaming text deltas don't re-render the input bar (and
// its aurora gradient + style recompute) on every tick. Props are stable
// across deltas: onSubmit/onAbort are useCallbacks in useChatState and
// busy only flips on transitions.
const ChatInputBar = memo(function ChatInputBar({
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

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
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
    },
    [value, onSubmit, busy],
  );

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
});
