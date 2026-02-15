"use client";

import { StarIcon, StarHalfIcon } from "lucide-react";

interface StarRatingProps {
  rating: number;
  count?: number;
  size?: "sm" | "md";
}

export function StarRating({ rating, count, size = "sm" }: StarRatingProps) {
  const filled = Math.floor(rating);
  const half = rating - filled >= 0.25 && rating - filled < 0.75;
  const empty = 5 - filled - (half ? 1 : 0);
  const iconSize = size === "sm" ? "size-3" : "size-3.5";

  return (
    <div className="flex items-center gap-1">
      <div className="flex">
        {Array.from({ length: filled }, (_, i) => (
          <StarIcon
            key={`f-${i}`}
            className={`${iconSize} fill-amber-400 text-amber-400`}
          />
        ))}
        {half && (
          <StarHalfIcon
            className={`${iconSize} fill-amber-400 text-amber-400`}
          />
        )}
        {Array.from({ length: empty }, (_, i) => (
          <StarIcon
            key={`e-${i}`}
            className={`${iconSize} text-muted-foreground/30`}
          />
        ))}
      </div>
      {count !== undefined && (
        <span className="text-[10px] text-muted-foreground">
          ({count.toLocaleString()})
        </span>
      )}
    </div>
  );
}
