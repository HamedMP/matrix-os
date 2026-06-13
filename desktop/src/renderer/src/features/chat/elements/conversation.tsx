import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// AI-Elements-style Conversation: messages sit at the BOTTOM (next to the
// composer) and the view sticks to the latest as content streams in. A
// jump-to-latest button appears when the user scrolls up.
export function Conversation({ children }: { children: ReactNode; scrollKey?: string | number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Mirror in a ref so the ResizeObserver reads the live value without
  // re-subscribing every render.
  const atBottomRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Stick to the bottom while content grows (new message, streaming tokens),
  // but only if the user hasn't scrolled away. Observing the content element
  // catches every growth without depending on a render tick.
  useEffect(() => {
    const el = ref.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    el.scrollTop = el.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto">
        {children}
      </div>
      {!atBottom ? (
        <button
          type="button"
          onClick={() => scrollToBottom()}
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
  // sits just above the composer) while longer ones scroll normally.
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-end gap-5 px-5 py-6">
      {children}
    </div>
  );
}

export function ConversationEmptyState({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center">{children}</div>;
}
