import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// AI-Elements-style Conversation: auto-scrolls to the bottom while streaming
// and shows a jump-to-latest button when the user scrolls up.
export function Conversation({ children, scrollKey }: { children: ReactNode; scrollKey: string | number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (atBottom) {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [atBottom, scrollKey]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto">
        {children}
      </div>
      {!atBottom ? (
        <button
          type="button"
          onClick={scrollToBottom}
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
  return <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6">{children}</div>;
}

export function ConversationEmptyState({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center">{children}</div>;
}
