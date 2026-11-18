"use client";

import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { FileResourceRefSchema } from "@matrix-os/contracts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { readBoundedFileBlob } from "@/lib/read-bounded-file-blob";

const Entries = z.object({ entries: z.array(z.object({
  name: z.string().min(1).max(512).refine((value) => !/[\\/]/.test(value) && value !== "." && value !== ".."),
  type: z.enum(["file", "directory"]),
})).max(5000) });

export function MatrixAttachmentPicker({ gatewayUrl, pending, error, close, select }: {
  gatewayUrl: string;
  pending: boolean;
  error: string | null;
  close: () => void;
  select: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ path: string; entries: z.infer<typeof Entries>["entries"] | null } | null>(null);
  const data = result?.path === path ? result : null;

  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${gatewayUrl}/api/files/list?path=${encodeURIComponent(path)}`, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        });
        const blob = await readBoundedFileBlob(response, 4 * 1024 * 1024);
        const { entries } = Entries.parse(JSON.parse(await blob.text()));
        if (!request.signal.aborted) setResult({ path, entries });
      } catch (error: unknown) {
        if (!request.signal.aborted) {
          console.warn("[chat] Matrix file listing unavailable", error instanceof Error ? error.name : "UnknownError");
          setResult({ path, entries: null });
        }
      }
    })();
    return () => request.abort();
  }, [attempt, gatewayUrl, path]);

  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent style={{ zIndex: SHELL_Z_INDEX.appDialog }} overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog - 1 }}>
      <DialogTitle>Attach from Matrix Files</DialogTitle>
      <DialogDescription>Choose a file from this Matrix Computer.</DialogDescription>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <button type="button" disabled={!path || pending} className="rounded px-2 py-1 hover:bg-accent disabled:opacity-50"
          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>Up</button>
        <span className="truncate">{path || "Matrix home"}</span>
      </div>
      {data === null ? <p role="status">Loading files…</p> : data.entries === null ? (
        <div role="alert" className="text-sm">Files unavailable. <button type="button" className="underline" onClick={() => {
          setResult(null);
          setAttempt(value => value + 1);
        }}>Retry</button></div>
      ) : data.entries.length === 0 ? <p className="text-sm">This folder is empty.</p> : (
        <ul className="max-h-[45vh] overflow-auto text-sm" aria-busy={pending}>
          {data.entries.map(entry => <li key={entry.name}>
            <button type="button" className="block w-full truncate rounded px-2 py-2 text-left hover:bg-accent disabled:opacity-50" disabled={pending}
              aria-label={`${entry.type === "directory" ? "Open" : "Attach"} ${entry.name}`}
              onClick={() => {
                const next = path ? `${path}/${entry.name}` : entry.name;
                if (!FileResourceRefSchema.safeParse({ kind: "home", path: next }).success) return;
                if (entry.type === "directory") setPath(next);
                else select(next);
              }}>{entry.type === "directory" ? `${entry.name}/` : entry.name}</button>
          </li>)}
        </ul>
      )}
      {pending ? <p role="status" className="text-sm">Reading file…</p> : null}
    </DialogContent>
  </Dialog>;
}
