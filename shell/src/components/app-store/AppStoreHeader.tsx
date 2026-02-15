"use client";

import { useRef, useEffect } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { CATEGORIES, type Category } from "@/stores/app-store";

interface AppStoreHeaderProps {
  search: string;
  selectedCategory: Category;
  onSearchChange: (value: string) => void;
  onCategoryChange: (category: Category) => void;
  onClose: () => void;
}

export function AppStoreHeader({
  search,
  selectedCategory,
  onSearchChange,
  onCategoryChange,
  onClose,
}: AppStoreHeaderProps) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (activeRef.current && tabsRef.current) {
      const container = tabsRef.current;
      const button = activeRef.current;
      const scrollLeft = button.offsetLeft - container.offsetWidth / 2 + button.offsetWidth / 2;
      container.scrollTo({ left: scrollLeft, behavior: "smooth" });
    }
  }, [selectedCategory]);

  return (
    <div className="bg-card/60 backdrop-blur-xl border-b border-border/50">
      <div className="flex items-center gap-4 px-6 pt-5 pb-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">App Store</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Discover, build, and install apps
          </p>
        </div>

        <div className="relative w-56 hidden sm:block">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search..."
            className="h-9 w-full rounded-full border-0 bg-muted/80 pl-9 pr-8 text-sm outline-none placeholder:text-muted-foreground/60 focus:bg-muted focus:ring-2 focus:ring-primary/20 transition-all"
          />
          {search && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 flex items-center justify-center rounded-full bg-muted-foreground/20 hover:bg-muted-foreground/40 transition-colors"
            >
              <XIcon className="size-2.5" />
            </button>
          )}
        </div>

        <button
          onClick={onClose}
          className="size-8 flex items-center justify-center rounded-full bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {/* Mobile search */}
      <div className="px-6 pb-3 sm:hidden">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search apps..."
            className="h-9 w-full rounded-full border-0 bg-muted/80 pl-9 pr-8 text-sm outline-none placeholder:text-muted-foreground/60 focus:bg-muted focus:ring-2 focus:ring-primary/20 transition-all"
          />
          {search && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 flex items-center justify-center rounded-full bg-muted-foreground/20 hover:bg-muted-foreground/40 transition-colors"
            >
              <XIcon className="size-2.5" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={tabsRef}
        className="flex gap-0.5 px-6 overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: "none" }}
      >
        {CATEGORIES.map((cat) => {
          const active = selectedCategory === cat;
          return (
            <button
              key={cat}
              ref={active ? activeRef : undefined}
              onClick={() => onCategoryChange(cat)}
              className={`shrink-0 px-3.5 pb-2.5 pt-1 text-[13px] font-medium transition-colors relative ${
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              {cat}
              {active && (
                <span className="absolute bottom-0 inset-x-1 h-[2px] bg-primary rounded-full" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
