"use client";

import { useState, useEffect, useCallback } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { Trash2Icon, RotateCcwIcon } from "lucide-react";

const GATEWAY_URL = getGatewayUrl();

interface TrashEntry {
  name: string;
  originalPath: string;
  deletedAt: string;
  size?: number;
  type: "file" | "directory";
}

export function TrashView() {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${GATEWAY_URL}/api/files/trash`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries);
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRestore(trashPath: string) {
    await fetch(`${GATEWAY_URL}/api/files/trash/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashPath }),
    });
    load();
  }

  async function handleEmpty() {
    if (!confirm("Permanently delete all items in Trash?")) return;
    await fetch(`${GATEWAY_URL}/api/files/trash/empty`, {
      method: "POST",
    });
    load();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading trash...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Trash2Icon className="size-4" />
          Trash ({entries.length} items)
        </div>
        {entries.length > 0 && (
          <Button variant="destructive" size="sm" onClick={handleEmpty}>
            Empty Trash
          </Button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground gap-2">
          <Trash2Icon className="size-10" />
          <div className="text-sm">Trash is empty</div>
        </div>
      ) : (
        <div className="overflow-auto flex-1">
          {entries.map((entry) => (
            <div
              key={entry.originalPath + entry.deletedAt}
              className="flex items-center gap-3 px-3 py-2 border-b border-border/30 hover:bg-accent/50"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{entry.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {entry.originalPath}
                </div>
                <div className="text-xs text-muted-foreground">
                  Deleted {new Date(entry.deletedAt).toLocaleString()}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRestore(`.trash/${entry.name}`)}
                title="Restore"
              >
                <RotateCcwIcon className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
