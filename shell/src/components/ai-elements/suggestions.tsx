"use client";

// Inspired by AI Elements suggestion chips pattern
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type SuggestionChipProps = Omit<HTMLAttributes<HTMLButtonElement>, "onSelect"> & {
  label: string;
  onSelect: (label: string) => void;
  index?: number;
};

export function SuggestionChip({
  label,
  onSelect,
  index = 0,
  className,
  ...props
}: SuggestionChipProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(label)}
      className={cn(
        "shrink-0 rounded-full border border-border bg-card/80 px-3 py-1.5 text-xs text-foreground",
        "hover:bg-accent/50 hover:border-accent transition-all duration-150",
        "animate-in fade-in slide-in-from-bottom-1",
        className,
      )}
      style={{ animationDelay: `${index * 50}ms`, animationFillMode: "both" }}
      {...props}
    >
      {label}
    </button>
  );
}

export type SuggestionChipsProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  suggestions: string[];
  onSelect: (text: string) => void;
  visible?: boolean;
};

export function SuggestionChips({
  suggestions,
  onSelect,
  visible = true,
  className,
  ...props
}: SuggestionChipsProps) {
  if (!visible || suggestions.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap gap-2 justify-center",
        className,
      )}
      // react-doctor-disable-next-line jsx-a11y/prefer-tag-over-role -- role="group" has no behavior-preserving native tag; the rule's suggested <address> is for contact info and adds italic styling
      role="group"
      aria-label="Suggested messages"
      {...props}
    >
      {suggestions.map((label, i) => (
        <SuggestionChip
          key={label}
          label={label}
          onSelect={onSelect}
          index={i}
        />
      ))}
    </div>
  );
}
