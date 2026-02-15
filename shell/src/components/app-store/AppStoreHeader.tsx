"use client";

import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
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
  return (
    <div className="border-b border-border bg-card/50 backdrop-blur-sm">
      <div className="flex items-center gap-3 px-6 py-3">
        <h1 className="text-lg font-bold shrink-0">App Store</h1>

        <div className="relative flex-1 max-w-sm">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search apps..."
            className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <button
          onClick={onClose}
          className="size-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors shrink-0"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <ScrollArea className="px-6 pb-2">
        <div className="flex gap-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => onCategoryChange(cat)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                selectedCategory === cat
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
        <ScrollBar orientation="horizontal" className="h-1" />
      </ScrollArea>
    </div>
  );
}
