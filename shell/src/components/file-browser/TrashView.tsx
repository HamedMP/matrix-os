"use client";

import { useState, useEffect, useCallback } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { Trash2Icon, RotateCcwIcon } from "lucide-react";

const GATEWAY_URL = getGatewayUrl();
const TRASH_FETCH_TIMEOUT_MS = 10_000;

interface TrashEntry {
  name: string;
  originalPath: string;
  deletedAt: string;
  trashPath: string;
  size?: number;
  type: "file" | "directory";
}

export function TrashView() {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by the on-mount useEffect dependency array below; removing useCallback would re-run the effect on every render and refetch the trash listing in a loop.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${GATEWAY_URL}/api/files/trash`, {
        signal: AbortSignal.timeout(TRASH_FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries);
      }
    } catch (error: unknown) {
      console.warn("Failed to load trash entries", error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- on-mount async load of the trash listing from the gateway; `load` toggles the loading gate and stores the fetched entries, none of which is derivable in render.
    load();
  }, [load]);

  async function handleRestore(trashPath: string) {
    await fetch(`${GATEWAY_URL}/api/files/trash/restore`, {
      method: "POST",
      signal: AbortSignal.timeout(TRASH_FETCH_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashPath }),
    });
    load();
  }

  async function handleEmpty() {
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setConfirmEmpty(false);
    await fetch(`${GATEWAY_URL}/api/files/trash/empty`, {
      method: "POST",
      signal: AbortSignal.timeout(TRASH_FETCH_TIMEOUT_MS),
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
          <Button
            variant="destructive"
            size="sm"
            onClick={handleEmpty}
            onBlur={() => setConfirmEmpty(false)}
          >
            {confirmEmpty ? "Confirm Empty" : "Empty Trash"}
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
                onClick={() => handleRestore(entry.trashPath)}
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
