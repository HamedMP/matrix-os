import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** The host reserves its actions first; only the remaining title viewport scrolls. */
export function OverflowingChatTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    const measure = () => setScrollDistance(Math.max(0, Math.ceil(text.scrollWidth - viewport.clientWidth)));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [title]);

  return (
    <span ref={viewportRef} className="matrix-chat-title-viewport"
      data-overflowing={scrollDistance > 0 ? "true" : "false"}
      style={{ "--chat-title-scroll-distance": `${scrollDistance}px` } as CSSProperties}>
      <span ref={textRef} className="matrix-chat-title-text" title={title}>{title}</span>
    </span>
  );
}
