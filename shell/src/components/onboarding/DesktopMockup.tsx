"use client";

import { useEffect, useState } from "react";

interface DesktopMockupProps {
  highlights: string[];
}

const ELEMENTS = [
  { id: "wallpaper", label: "Wallpaper" },
  { id: "dock", label: "Dock" },
  { id: "windows", label: "Apps" },
  { id: "chat", label: "AI Chat" },
  { id: "toolbar", label: "Toolbar" },
] as const;

export function DesktopMockup({ highlights }: DesktopMockupProps) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Stagger reveal of highlighted elements
    highlights.forEach((id, i) => {
      setTimeout(() => {
        setRevealed((prev) => new Set([...prev, id]));
      }, 300 + i * 400);
    });
  }, [highlights]);

  const isActive = (id: string) => revealed.has(id);

  return (
    <div className="w-full max-w-md">
      {/* Desktop container */}
      <div
        className="relative aspect-[16/10] rounded-2xl border border-foreground/8 bg-foreground/[0.02] overflow-hidden"
      >
        {/* Wallpaper background */}
        <div
          className="absolute inset-0 transition-opacity duration-700"
          style={{
            opacity: isActive("wallpaper") ? 0.06 : 0,
            background: "linear-gradient(135deg, rgba(120,160,200,0.3) 0%, rgba(180,140,100,0.2) 100%)",
          }}
        />

        {/* Toolbar — top bar */}
        <div
          className="absolute top-0 inset-x-0 h-[8%] border-b border-foreground/5 bg-foreground/[0.03] flex items-center px-3 transition-all duration-500"
          style={{
            opacity: isActive("toolbar") ? 1 : 0,
            transform: isActive("toolbar") ? "translateY(0)" : "translateY(-100%)",
          }}
        >
          <div className="flex gap-1">
            <div className="size-1.5 rounded-full bg-foreground/15" />
            <div className="size-1.5 rounded-full bg-foreground/15" />
            <div className="size-1.5 rounded-full bg-foreground/15" />
          </div>
          <div className="ml-auto flex gap-2">
            <div className="w-6 h-1.5 rounded bg-foreground/8" />
            <div className="w-4 h-1.5 rounded bg-foreground/8" />
          </div>
        </div>

        {/* Dock — left side */}
        <div
          className="absolute left-2 top-[12%] bottom-[4%] w-[8%] rounded-xl border border-foreground/6 bg-foreground/[0.03] flex flex-col items-center pt-2 gap-1.5 transition-all duration-500"
          style={{
            opacity: isActive("dock") ? 1 : 0,
            transform: isActive("dock") ? "translateX(0)" : "translateX(-12px)",
          }}
        >
          {[...Array(5)].map((_, i) => (
            <div key={i} className="w-[60%] aspect-square rounded-lg bg-foreground/8" />
          ))}
        </div>

        {/* Windows — center area */}
        <div
          className="absolute left-[14%] top-[14%] w-[50%] h-[70%] transition-all duration-600"
          style={{
            opacity: isActive("windows") ? 1 : 0,
            transform: isActive("windows") ? "scale(1)" : "scale(0.95)",
          }}
        >
          {/* Window 1 */}
          <div className="absolute inset-0 rounded-xl border border-foreground/8 bg-foreground/[0.02] overflow-hidden">
            <div className="h-[14%] border-b border-foreground/5 bg-foreground/[0.03] flex items-center px-2">
              <div className="w-8 h-1.5 rounded bg-foreground/10" />
            </div>
            <div className="p-2 space-y-1.5">
              <div className="w-[80%] h-1.5 rounded bg-foreground/6" />
              <div className="w-[60%] h-1.5 rounded bg-foreground/4" />
              <div className="w-[70%] h-1.5 rounded bg-foreground/5" />
            </div>
          </div>
          {/* Window 2 (overlapping) */}
          <div className="absolute top-[20%] left-[15%] right-[-10%] bottom-[-10%] rounded-xl border border-foreground/6 bg-background/80 overflow-hidden">
            <div className="h-[14%] border-b border-foreground/5 bg-foreground/[0.02] flex items-center px-2">
              <div className="w-10 h-1.5 rounded bg-foreground/8" />
            </div>
            <div className="p-2 space-y-1.5">
              <div className="w-[70%] h-1.5 rounded bg-foreground/5" />
              <div className="w-[50%] h-1.5 rounded bg-foreground/4" />
            </div>
          </div>
        </div>

        {/* Chat panel — right side */}
        <div
          className="absolute right-2 top-[12%] bottom-[4%] w-[28%] rounded-xl border border-foreground/6 bg-foreground/[0.02] flex flex-col transition-all duration-500"
          style={{
            opacity: isActive("chat") ? 1 : 0,
            transform: isActive("chat") ? "translateX(0)" : "translateX(12px)",
          }}
        >
          <div className="h-[10%] border-b border-foreground/5 flex items-center px-2">
            <div className="w-6 h-1.5 rounded bg-foreground/8" />
          </div>
          <div className="flex-1 p-2 flex flex-col justify-end gap-1">
            <div className="self-end w-[70%] h-2 rounded-lg bg-foreground/6" />
            <div className="self-start w-[80%] h-2 rounded-lg bg-foreground/4" />
            <div className="self-end w-[50%] h-2 rounded-lg bg-foreground/6" />
          </div>
          <div className="h-[12%] border-t border-foreground/5 mx-2 mb-1 rounded-lg bg-foreground/[0.03]" />
        </div>

        {/* Labels for active elements */}
        {ELEMENTS.filter((el) => isActive(el.id)).length > 0 && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-2">
            {ELEMENTS.filter((el) => isActive(el.id)).map((el) => (
              <span
                key={el.id}
                className="text-[9px] uppercase tracking-widest text-foreground/30 px-2 py-0.5 rounded-full border border-foreground/5"
              >
                {el.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
