import React, { useLayoutEffect, useRef, useState } from "react";
import { FilePathSchema } from "@matrix-os/contracts";
import { Trash2 } from "@renderer/lib/hugeicons";
import { z } from "zod/v4";
import { Button, Dialog, IconButton } from "../../design/primitives";
import { AppError, diagnosticErrorKind } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { isProtectedFolderPickerPath } from "./browser-entries";

const TrashListSchema = z.object({
  entries: z.array(z.object({
    name: z.string().min(1).max(4096),
    originalPath: z.string().min(1).max(4096),
    trashPath: z.string().min(1).max(4096),
  })).max(10_000),
});
type TrashEntry = z.infer<typeof TrashListSchema>["entries"][number];
type MoveTarget = { path: string; type: "file" | "directory" };
type Notice = { text: string; error: boolean };

export function canMoveFileToTrash(path: string): boolean {
  return FilePathSchema.safeParse(path).success && !path.includes("\\")
    && !isProtectedFolderPickerPath(path)
    && path !== "data/app-gallery-staging" && !path.startsWith("data/app-gallery-staging/");
}

export function useFileTrash(enabled: boolean, onFilesChanged: (movedPath?: string) => void) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [target, setTarget] = useState<MoveTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const onFilesChangedRef = useRef(onFilesChanged);

  useLayoutEffect(() => { onFilesChangedRef.current = onFilesChanged; }, [onFilesChanged]);
  useLayoutEffect(() => {
    setTarget(null);
    setOpen(false);
    setEntries(null);
    setNotice(null);
    setPending(false);
    return () => { operation.current?.abort(); operation.current = null; };
  }, [enabled, api, runtimeSlot, authGeneration]);

  const isCurrent = () => {
    const state = useConnection.getState();
    return enabled && api && api === state.api && runtimeSlot === state.runtimeSlot && authGeneration === state.authGeneration;
  };

  const loadTrash = async (signal: AbortSignal) => {
    const result = await api!.forRuntime(runtimeSlot).get<unknown>("/api/files/trash", {
      signal, cache: "no-store", maxBytes: 4 * 1024 * 1024, omitErrorBody: true,
    });
    return TrashListSchema.parse(result).entries;
  };

  const run = async (action: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (!isCurrent() || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const current = () => operation.current === controller && !!isCurrent();
    setPending(true);
    setNotice(null);
    try { await action(controller.signal, current); }
    finally {
      if (current()) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  };

  const requestMove = (path: string, type: MoveTarget["type"]) => {
    if (isCurrent() && !operation.current && canMoveFileToTrash(path)) {
      setNotice(null);
      setTarget({ path, type });
    }
  };

  const openTrash = () => run(async (signal, current) => {
    setOpen(true);
    setEntries(null);
    try {
      const loaded = await loadTrash(signal);
      if (current()) setEntries(loaded);
    } catch (error) {
      console.warn("[files] Trash listing unavailable:", diagnosticErrorKind(error));
      if (current()) setNotice({ text: "Could not open Trash. Try again.", error: true });
    }
  });

  const confirmMove = () => {
    if (!target) return;
    void run(async (signal, current) => {
      let movedPath: string | undefined;
      try {
        const result = await api!.forRuntime(runtimeSlot).post<{ ok: boolean }>("/api/files/delete", { path: target.path }, {
          signal, maxBytes: 4096, omitErrorBody: true,
        });
        if (!result.ok) throw new Error("Trash move was not confirmed");
        movedPath = target.path;
        if (current()) setNotice({ text: "Moved to Trash.", error: false });
      } catch (error) {
        console.warn("[files] Move to Trash unavailable:", diagnosticErrorKind(error));
        if (current()) {
          const text = error instanceof AppError && (error.httpStatus === 403 || error.httpStatus === 409)
            ? "This file or folder cannot be moved to Trash here."
            : "Move to Trash could not be confirmed. Check Files or Trash.";
          setNotice({ text, error: true });
        }
      } finally {
        if (current()) {
          setTarget(null);
          onFilesChangedRef.current(movedPath);
        }
      }
    });
  };

  const restore = (entry: TrashEntry) => run(async (signal, current) => {
    try {
      const result = await api!.forRuntime(runtimeSlot).post<{ ok: boolean }>("/api/files/trash/restore", { trashPath: entry.trashPath }, {
        signal, maxBytes: 4096, omitErrorBody: true,
      });
      if (!result.ok) throw new Error("Trash restore was not confirmed");
      if (current()) {
        setEntries((previous) => previous?.filter((row) => row.trashPath !== entry.trashPath) ?? null);
        setNotice({ text: "Restored to the original location.", error: false });
      }
    } catch (error) {
      console.warn("[files] Restore unavailable:", diagnosticErrorKind(error));
      if (current()) {
        const text = error instanceof AppError && error.httpStatus === 409
          ? "The original location is occupied or unavailable."
          : "Restore could not be confirmed. Check Files or retry.";
        setNotice({ text, error: true });
      }
    } finally {
      if (current()) onFilesChangedRef.current();
    }
    try {
      const loaded = await loadTrash(signal);
      if (current()) setEntries(loaded);
    } catch (error) {
      console.warn("[files] Trash refresh unavailable:", diagnosticErrorKind(error));
    }
  });

  return {
    requestMove,
    openTrash,
    open, entries, notice, pending, target, confirmMove, restore,
    closeConfirm: () => { if (!operation.current) setTarget(null); },
    closeTrash: () => {
      if (operation.current) return;
      setOpen(false);
    },
  };
}

type FileTrash = ReturnType<typeof useFileTrash>;

export function OpenTrashButton({ trash }: { trash: FileTrash }) {
  return <IconButton
    label="Open Trash"
    className="h-8 w-8 shrink-0"
    disabled={trash.pending}
    onClick={() => { void trash.openTrash(); }}
  ><Trash2 size={16} aria-hidden /></IconButton>;
}

function TrashNotice({ notice }: { notice: Notice | null }) {
  return notice ? <p role={notice.error ? "alert" : "status"} className="px-3 py-1 text-xs" style={{
    color: "var(--text-secondary)",
  }}>{notice.text}</p> : null;
}

export function FileTrashDialogs({ trash }: { trash: FileTrash }) {
  const name = trash.target?.path.split("/").at(-1);
  const kind = trash.target?.type === "directory" ? "folder" : "file";
  return <>
    {!trash.open ? <TrashNotice notice={trash.notice} /> : null}
    <Dialog open={trash.target !== null} onClose={trash.closeConfirm} role="alertdialog" title="Move to Trash" placement="center" width={420}>
      <div className="p-5">
        <h2 className="text-base font-medium">Move {kind} to Trash?</h2>
        <p className="mt-2 break-words text-sm" style={{ color: "var(--text-secondary)" }}>
          Move <strong>{name}</strong>{kind === "folder" ? " and its contents" : ""} to Trash? You can restore it to its original location from Trash.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={trash.pending} onClick={trash.closeConfirm}>Cancel</Button>
          <Button variant="primary" disabled={trash.pending} onClick={trash.confirmMove}>
            {trash.pending ? "Moving…" : "Move to Trash"}
          </Button>
        </div>
      </div>
    </Dialog>
    <Dialog open={trash.open} onClose={trash.closeTrash} title="Trash" placement="center" width={520}>
      <div className="flex items-center justify-between border-b p-3" style={{ borderColor: "var(--border-subtle)" }}>
        <h2 className="text-base font-medium">Trash</h2>
        <Button variant="ghost" disabled={trash.pending} onClick={trash.closeTrash}>Close Trash</Button>
      </div>
      <TrashNotice notice={trash.notice} />
      {trash.entries === null && trash.pending ? <p role="status" className="p-3 text-sm">Loading Trash…</p> : null}
      {trash.entries?.length === 0 ? <p className="p-3 text-sm">Trash is empty.</p> : null}
      <ul className="max-h-[50vh] overflow-y-auto">
        {trash.entries?.map((entry) => <li key={entry.trashPath} className="flex items-center justify-between gap-3 border-b p-3" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="min-w-0">
            <p className="truncate text-sm" title={entry.name}>{entry.name}</p>
            <p className="truncate text-xs" style={{ color: "var(--text-secondary)" }} title={entry.originalPath}>{entry.originalPath}</p>
          </div>
          <Button variant="subtle" aria-label={`Restore ${entry.name}`} disabled={trash.pending} onClick={() => { void trash.restore(entry); }}>Restore</Button>
        </li>)}
      </ul>
    </Dialog>
  </>;
}
