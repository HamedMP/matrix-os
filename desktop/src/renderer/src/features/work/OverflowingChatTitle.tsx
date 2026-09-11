import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const CHAT_ROW_ACTION_OVERLAY_WIDTH = 56;

export function OverflowingChatTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    const measure = () => {
      const visibleWidth = Math.max(0, viewport.clientWidth - CHAT_ROW_ACTION_OVERLAY_WIDTH);
      setScrollDistance(Math.max(0, Math.ceil(text.scrollWidth - visibleWidth)));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [title]);

  const overflowing = scrollDistance > 0;
  return (
    <span
      ref={viewportRef}
      data-overflowing={overflowing ? "true" : "false"}
      className="min-w-0 flex-1 overflow-hidden"
      style={{ "--chat-title-scroll-distance": `${scrollDistance}px` } as CSSProperties}
    >
      <span
        ref={textRef}
        title={title}
        className={`block w-max max-w-none whitespace-nowrap ${overflowing
          ? "group-hover/chat:animate-[chat-title-scroll_4s_ease-in-out_infinite_alternate] group-focus-within/chat:animate-[chat-title-scroll_4s_ease-in-out_infinite_alternate] motion-reduce:animate-none"
          : ""}`}
      >
        {title}
      </span>
    </span>
  );
}
