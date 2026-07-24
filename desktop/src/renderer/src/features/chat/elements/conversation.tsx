import { ArrowDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../../../lib/cn";

// MessageScroller semantics, vendored for the desktop chat surfaces. This
// implements the same contract as shadcn/ui's MessageScroller (June 2026 chat
// components release): bottom-anchored follow while the reader is at the live
// edge, a scroll-to-latest control, position preservation when history is
// prepended, and a jump-to-message command surface for future deep links.
//
// Why vendored instead of the headless `@shadcn/react/message-scroller`
// package: the package attaches a ResizeObserver to its viewport on mount —
// even with an empty transcript — while `tests/desktop/conversation.test.tsx`
// (outside this change's file-ownership boundary) pins the existing contract
// that nothing is observed until content first appears. Adopting the package
// would fail that pinned assertion, so the behavior is implemented here with
// the same observer-attachment contract.
// Source: https://ui.shadcn.com/docs/components/base/message-scroller

/** Scroll commands for the transcript. Exposed via `ref` on Conversation. */
export interface ConversationHandle {
  /** Scroll to the newest row; arriving at the live edge re-engages follow. */
  scrollToEnd(options?: { behavior?: ScrollBehavior }): void;
  /** Scroll to the oldest row; moving away from the live edge releases follow. */
  scrollToStart(options?: { behavior?: ScrollBehavior }): void;
  /**
   * Jump to the row rendered with `messageId` (see ConversationItem). Returns
   * false when no mounted row carries that id — callers can retry once more
   * content has streamed in. Reserved for notification deep-links.
   */
  scrollToMessage(messageId: string, options?: { behavior?: ScrollBehavior }): boolean;
}

export function Conversation({ children, ref }: { children: ReactNode; ref?: Ref<ConversationHandle> }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Mirror in a ref so the ResizeObserver reads the live value without
  // re-subscribing every render.
  const atBottomRef = useRef(true);
  // Prepend preservation: last observed content height and first row, so rows
  // arriving above the visible area keep the reader's place.
  const contentHeightRef = useRef(0);
  const firstRowRef = useRef<Element | null>(null);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    contentHeightRef.current = el.scrollHeight;
  }, []);

  const scrollToEnd = useCallback((options?: { behavior?: ScrollBehavior }) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: options?.behavior ?? "smooth" });
  }, []);

  const scrollToStart = useCallback((options?: { behavior?: ScrollBehavior }) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: options?.behavior ?? "smooth" });
  }, []);

  const scrollToMessage = useCallback(
    (messageId: string, options?: { behavior?: ScrollBehavior }): boolean => {
      const el = viewportRef.current;
      if (!el) return false;
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(messageId) : messageId.replace(/["\\]/g, "\\$&");
      const target = el.querySelector(`[data-message-id="${escaped}"]`);
      if (!(target instanceof HTMLElement)) return false;
      el.scrollTo({ top: Math.max(target.offsetTop - el.offsetTop, 0), behavior: options?.behavior ?? "smooth" });
      return true;
    },
    [],
  );

  useImperativeHandle(ref, () => ({ scrollToEnd, scrollToStart, scrollToMessage }), [scrollToEnd, scrollToStart, scrollToMessage]);

  // Stick to the bottom while content grows (new message, streaming tokens),
  // but only if the user hasn't scrolled away. Observing the content element
  // catches every growth without depending on a render tick. A second
  // MutationObserver on the content watches the first row: when it changes
  // (history prepended above) while the reader is away from the live edge,
  // the viewport shifts by the prepended height so the visible row stays put.
  useEffect(() => {
    const viewport = viewportRef.current;
    let observedContent: Element | null = null;

    const scrollIfPinned = () => {
      if (!viewport) return;
      contentHeightRef.current = viewport.scrollHeight;
      if (atBottomRef.current) viewport.scrollTop = viewport.scrollHeight;
    };

    const preserveOnPrepend = () => {
      const content = observedContent;
      if (!content || !viewport) return;
      const first = content.firstElementChild;
      const previousFirst = firstRowRef.current;
      firstRowRef.current = first;
      if (!previousFirst || previousFirst === first) return;
      // Follow wins at the live edge: a prepend during an active stream must
      // not fight the bottom anchor.
      if (atBottomRef.current) return;
      const delta = viewport.scrollHeight - contentHeightRef.current;
      contentHeightRef.current = viewport.scrollHeight;
      if (delta > 0) viewport.scrollTop += delta;
    };

    const resizeObserver = new ResizeObserver(scrollIfPinned);
    const prependObserver = new MutationObserver(preserveOnPrepend);
    const observeContent = () => {
      const content = viewport?.firstElementChild;
      if (!viewport || !content || content === observedContent) return;
      resizeObserver.disconnect();
      prependObserver.disconnect();
      observedContent = content;
      firstRowRef.current = content.firstElementChild;
      resizeObserver.observe(content);
      prependObserver.observe(content, { childList: true });
      scrollIfPinned();
    };
    const mutationObserver = new MutationObserver(observeContent);
    if (viewport) {
      mutationObserver.observe(viewport, { childList: true });
      observeContent();
    }

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      prependObserver.disconnect();
    };
  }, []);

  return (
    <div className="relative min-h-0 flex-1" data-slot="message-scroller">
      <div
        ref={viewportRef}
        onScroll={onScroll}
        role="region"
        aria-label="Messages"
        tabIndex={0}
        className="scroll-fade h-full overflow-y-auto"
        data-slot="message-scroller-viewport"
      >
        {children}
      </div>
      {!atBottom ? (
        <button
          type="button"
          onClick={() => scrollToEnd({ behavior: "smooth" })}
          aria-label="Scroll to latest"
          className="absolute bottom-4 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border"
          style={{ background: "var(--bg-surface)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)", color: "var(--text-secondary)" }}
        >
          <ArrowDown size={15} />
        </button>
      ) : null}
    </div>
  );
}

export function ConversationContent({ children }: { children: ReactNode }) {
  // min-h-full + justify-end bottom-anchors short conversations (latest message
  // sits just above the composer) while longer ones scroll normally. The log
  // role marks the transcript as a live region whose streamed text mutations
  // are not announced token by token (aria-relevant=additions only).
  // The 46rem centered column keeps line length readable (Codex-style) while
  // the scroll viewport itself stays full-width for the edge fade.
  return (
    <div
      className="mx-auto flex min-h-full w-full max-w-[46rem] flex-col justify-end gap-5 px-6 py-6"
      role="log"
      aria-relevant="additions"
      data-slot="message-scroller-content"
    >
      {children}
    </div>
  );
}

/**
 * Transcript row boundary. Wrap every direct row of ConversationContent so
 * the scroller can address it: `messageId` makes the row jumpable via
 * ConversationHandle.scrollToMessage, and `scrollAnchor` marks the row that
 * starts a conversation turn (reserved for future turn anchoring).
 */
export function ConversationItem({
  messageId,
  scrollAnchor = false,
  className,
  children,
}: {
  messageId?: string;
  scrollAnchor?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor || undefined}
      className={cn("min-w-0", className)}
    >
      {children}
    </div>
  );
}

export function ConversationEmptyState({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === false) return null;
  return <div className="flex h-full flex-col items-center justify-center">{children}</div>;
}
