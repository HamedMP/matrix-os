"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { useFileBrowser, watchFileBrowserAuthority } from "@/hooks/useFileBrowser";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { Button } from "@/components/ui/button";
import { Trash2Icon, RotateCcwIcon } from "@/lib/hugeicons";

const TRASH_FETCH_TIMEOUT_MS = 10_000;

interface TrashEntry {
  name: string;
  originalPath: string;
  deletedAt: string;
  trashPath: string;
  size?: number;
  type: "file" | "directory";
}

export function TrashView({ gatewayUrl }: { gatewayUrl: string }) {
  const draftAuthority = usePreviewWindow(state => state.draftAuthority);
  return <TrashViewForAuthority key={draftAuthority ?? ""} gatewayUrl={gatewayUrl} draftAuthority={draftAuthority} />;
}

function TrashViewForAuthority({ gatewayUrl, draftAuthority }: { gatewayUrl: string; draftAuthority: string | null }) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by the on-mount useEffect dependency array below; removing useCallback would re-run the effect on every render and refetch the trash listing in a loop.
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(`${gatewayUrl}/api/files/trash`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRASH_FETCH_TIMEOUT_MS)]),
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Trash listing unavailable");
      const data = await res.json();
      if (!data || !Array.isArray(data.entries)) throw new Error("Invalid Trash listing");
      if (!signal.aborted && getGatewayUrl() === gatewayUrl) setEntries(data.entries);
    } catch (error: unknown) {
      if (signal.aborted) return;
      console.warn("[file-browser] Trash listing unavailable:", error instanceof Error ? error.name : "UnknownError");
      setError("Could not load Trash. Try again.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [gatewayUrl]);

  useEffect(() => {
    const controller = new AbortController();
    const authority = watchFileBrowserAuthority(gatewayUrl);
    void load(AbortSignal.any([controller.signal, authority.signal])).finally(() => {
      authority.unsubscribe();
      if (authority.signal.aborted && !controller.signal.aborted) {
        setLoading(false);
        setError("Could not load Trash. Reopen Trash and try again.");
      }
    });
    return () => {
      controller.abort();
      authority.unsubscribe();
      operation.current?.abort();
      operation.current = null;
    };
  }, [gatewayUrl, load]);

  async function mutate(path: "/restore" | "/empty", failure: string, body?: { trashPath: string }) {
    if (operation.current || getGatewayUrl() !== gatewayUrl || usePreviewWindow.getState().draftAuthority !== draftAuthority) return;
    const controller = new AbortController();
    const authority = watchFileBrowserAuthority(gatewayUrl);
    const signal = AbortSignal.any([controller.signal, authority.signal]);
    operation.current = controller;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${gatewayUrl}/api/files/trash${path}`, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRASH_FETCH_TIMEOUT_MS)]),
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!signal.aborted && authority.isCurrent()) {
        if (!res.ok) setError(failure);
        else if (path === "/restore") useFileBrowser.getState().refresh();
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        console.warn("[file-browser] Trash operation unavailable:", error instanceof Error ? error.name : "UnknownError");
        setError(failure);
      }
    } finally {
      if (!signal.aborted && authority.isCurrent()) await load(signal);
      authority.unsubscribe();
      if (operation.current === controller) {
        operation.current = null;
        setPending(false);
      }
    }
  }

  async function handleEmpty() {
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setConfirmEmpty(false);
    await mutate("/empty", "Empty Trash could not be confirmed. Check the remaining items.");
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
            disabled={pending}
            onBlur={() => setConfirmEmpty(false)}
          >
            {confirmEmpty ? "Confirm Empty" : "Empty Trash"}
          </Button>
        )}
      </div>

      {error ? <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {entries.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground gap-2">
          <Trash2Icon className="size-10" />
          <div className="text-sm">Trash is empty</div>
        </div>
      ) : (
        <div className="overflow-auto flex-1">
          {entries.map((entry) => (
            <div
              key={entry.trashPath}
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
                onClick={() => { void mutate("/restore", "Could not restore the item. Check its original location and try again.", { trashPath: entry.trashPath }); }}
                aria-label={`Restore ${entry.name}`}
                disabled={pending}
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
