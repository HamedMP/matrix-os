"use client";

import type { UIOptionData } from "@/lib/ui-blocks";

interface OptionListProps {
  options: UIOptionData[];
  onSelect?: (option: UIOptionData) => void;
}

export function OptionList({ options, onSelect }: OptionListProps) {
  return (
    <div className="flex flex-wrap gap-1.5 my-2">
      {options.map((option, i) => (
        <button
          key={i}
          onClick={() => onSelect?.(option)}
          className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium hover:bg-accent hover:border-accent-foreground/20 transition-colors"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
