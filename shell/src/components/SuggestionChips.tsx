"use client";

import { Button } from "@/components/ui/button";

type ChipContext = "empty" | "app" | "error";

const CHIPS: Record<ChipContext, string[]> = {
  empty: [
    "Build me a notes app",
    "Create an expense tracker",
    "Show what you can do",
  ],
  app: [
    "Add dark mode",
    "Make it faster",
    "Add a search feature",
  ],
  error: [
    "Fix this",
    "Show me what went wrong",
  ],
};

interface SuggestionChipsProps {
  context: ChipContext;
  onSelect: (text: string) => void;
}

export function SuggestionChips({ context, onSelect }: SuggestionChipsProps) {
  const chips = CHIPS[context];

  return (
    <div className="flex flex-wrap justify-center gap-2">
      {chips.map((chip) => (
        <Button
          key={chip}
          variant="outline"
          size="sm"
          className="h-7 rounded-full border-border/60 bg-card/60 text-xs backdrop-blur-sm"
          onClick={() => onSelect(chip)}
        >
          {chip}
        </Button>
      ))}
    </div>
  );
}
