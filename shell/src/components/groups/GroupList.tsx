"use client";

import { UsersIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { GroupEntry } from "./GroupsApp";

interface GroupListProps {
  groups: GroupEntry[];
  loading: boolean;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}

export function GroupList({ groups, loading, selectedSlug, onSelect }: GroupListProps) {
  if (loading) {
    return (
      <div className="p-3 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 text-center">
        <p className="text-xs text-foreground/40">No groups yet</p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-2 space-y-0.5">
        {groups.map((g) => (
          <button
            key={g.slug}
            data-testid={`groups-list-item-${g.slug}`}
            onClick={() => onSelect(g.slug)}
            className={`flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
              g.slug === selectedSlug
                ? "bg-primary/10 text-foreground"
                : "text-foreground/70 hover:bg-foreground/5"
            }`}
          >
            <UsersIcon className="size-4 shrink-0 opacity-50" />
            <span className="text-sm truncate">{g.name}</span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
