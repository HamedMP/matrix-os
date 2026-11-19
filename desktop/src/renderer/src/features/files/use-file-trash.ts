import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod/v4";
import type { ApiClient } from "../../lib/api";
import { AppError, classifyTransportError } from "../../../../shared/app-error";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";

interface TrashAuthority {
  api: ApiClient;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

type TrashChange =
  | { kind: "move"; path: string }
  | { kind: "restore"; path: string; trashPath: string; entryId: string };

const undoEntrySchema = z.object({
  trashPath: z.string().regex(/^\.trash\/(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]+$/),
  entryId: z.uuid(),
});

export function useFileTrash(
  runtimeSlot: string,
  authGeneration: number,
  onChange: (path: string, removed: boolean) => void,
) {
  const [pending, setPending] = useState(false);
  const scope = useRef<AbortController | null>(null);
  const busy = useRef<TrashAuthority | null>(null);
  const undoToast = useRef<string | number | null>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    setPending(false);
    return () => {
      controller.abort();
      scope.current = null;
      busy.current = null;
      if (undoToast.current !== null) toast.dismiss(undoToast.current);
      undoToast.current = null;
    };
  }, [authGeneration, runtimeSlot]);

  async function changeTrash(authority: TrashAuthority, change: TrashChange) {
    if (busy.current || !authority.isCurrent()) return;
    busy.current = authority;
    setPending(true);
    const options = { signal: authority.signal, maxBytes: 4096, omitErrorBody: true };
    try {
      const moving = change.kind === "move";
      const reply = moving
        ? await authority.api.post<{ ok?: unknown }>("/api/files/delete", { path: change.path, withUndo: true }, options)
        : await authority.api.post<{ ok?: unknown }>("/api/files/trash/restore", { trashPath: change.trashPath, entryId: change.entryId }, options);
      if (!authority.isCurrent()) return;
      if (reply?.ok !== true) {
        toast.error(moving ? "Could not move to Trash." : "Could not restore from Trash.");
        return;
      }

      onChange(change.path, moving);
      if (undoToast.current !== null) toast.dismiss(undoToast.current);
      undoToast.current = null;
      if (!moving) {
        toast.success("Restored from Trash");
        return;
      }

      const undoEntry = undoEntrySchema.safeParse(reply);
      undoToast.current = toast.success("Moved to Trash", {
        duration: 8000,
        action: undoEntry.success ? {
          label: "Undo",
          onClick: (event) => {
            event.preventDefault();
            void changeTrash(authority, { kind: "restore", path: change.path, ...undoEntry.data });
          },
        } : undefined,
      });
    } catch (error: unknown) {
      const cause = error instanceof AppError ? error.cause : error;
      if (!authority.isCurrent() || authority.signal.aborted
        || ((cause instanceof DOMException || cause instanceof Error) && cause.name === "AbortError")) return;
      const category = error instanceof AppError ? error.category : classifyTransportError(error);
      console.warn("[files-trash] Request failed", { operation: change.kind, category });
      toast.error(change.kind === "move" ? "Could not move to Trash." : "Could not restore from Trash.");
    } finally {
      if (busy.current === authority) {
        busy.current = null;
        setPending(false);
      }
    }
  }

  function move(path: string): void {
    const { api } = useConnection.getState();
    const signal = scope.current?.signal;
    if (!api || !signal) return;
    const generation = captureRuntimeGeneration();
    const isCurrent = () => {
      const connection = useConnection.getState();
      return !signal.aborted && isCurrentRuntimeGeneration(generation)
        && connection.status === "signed-in" && connection.api?.baseUrl === api.baseUrl
        && connection.runtimeSlot === runtimeSlot && connection.authGeneration === authGeneration;
    };
    if (!isCurrent()) return;
    void changeTrash({ api: api.forRuntime(runtimeSlot), signal, isCurrent }, { kind: "move", path });
  }

  return { move, pending };
}
