"use client";

import type { UICardData } from "@/lib/ui-blocks";

interface CardGridProps {
  cards: UICardData[];
  onSelect?: (card: UICardData) => void;
}

export function CardGrid({ cards, onSelect }: CardGridProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 my-2">
      {cards.map((card, i) => (
        <button
          key={i}
          onClick={() => onSelect?.(card)}
          className="flex flex-col items-start gap-1 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent hover:border-accent-foreground/20 transition-colors"
        >
          {card.emoji && (
            <span className="text-lg">{card.emoji}</span>
          )}
          <span className="text-sm font-medium">{card.title}</span>
          {card.description && (
            <span className="text-xs text-muted-foreground line-clamp-2">
              {card.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
