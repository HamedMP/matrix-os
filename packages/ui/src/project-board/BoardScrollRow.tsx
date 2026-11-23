"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { focusRing, tone } from "./board-style.js";

const SCROLL_STEP = 280;
const EDGE_TOLERANCE = 2;

/**
 * Horizontal row of columns. When columns run past the edge, a fade and a
 * round arrow button mark that side, so hidden columns are never silently clipped.
 */
export function BoardScrollRow({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const left = element.scrollLeft > EDGE_TOLERANCE;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - EDGE_TOLERANCE;
      setEdges((current) => (current.left === left && current.right === right ? current : { left, right }));
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    // Older embedded runtimes lack ResizeObserver; they still update on scroll and window resize.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    window.addEventListener("resize", measure);
    return () => {
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  const scrollBy = (direction: -1 | 1) => row.current?.scrollBy({ left: direction * SCROLL_STEP, behavior: "smooth" });
  return <div className="relative flex min-h-0 flex-1">
    {/* Columns share the width down to 240px each, then the row scrolls. */}
    <div ref={row} data-slot="project-board-columns"
      className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-3 pt-1 [scrollbar-color:var(--border-default,var(--border))_transparent] [scrollbar-width:thin]">
      {children}
    </div>
    {edges.left ? <EdgeButton side="left" onClick={() => scrollBy(-1)} /> : null}
    {edges.right ? <EdgeButton side="right" onClick={() => scrollBy(1)} /> : null}
  </div>;
}

function EdgeButton({ side, onClick }: { side: "left" | "right"; onClick(): void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return <div className={`pointer-events-none absolute inset-y-0 flex w-14 items-center ${side === "left" ? "left-0 justify-start pl-1.5" : "right-0 justify-end pr-1.5"}`}
    style={{ background: `linear-gradient(to ${side === "left" ? "right" : "left"}, var(--bg-app, var(--background)) 20%, transparent)` }}>
    <button type="button" onClick={onClick} aria-label={side === "left" ? "Scroll to earlier columns" : "Scroll to more columns"}
      className={`pointer-events-auto grid size-8 place-items-center rounded-full border shadow-sm hover:bg-[var(--bg-hover)] ${focusRing}`}
      style={{ ...tone.border, ...tone.secondary, background: "var(--bg-surface, var(--card))" }}>
      <Icon size={15} aria-hidden />
    </button>
  </div>;
}
