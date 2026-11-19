"use client";

import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { FileResourceRefSchema } from "@matrix-os/contracts";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeftIcon, ChevronRightIcon, FileIcon, FolderIcon, SearchIcon, UploadIcon, XIcon } from "@/lib/hugeicons";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { readBoundedFileBlob } from "@/lib/read-bounded-file-blob";
import "./matrix-attachment-picker.css";

const Entries = z.object({ entries: z.array(z.object({
  name: z.string().min(1).max(512).refine((value) => !/[\\/]/.test(value) && value !== "." && value !== ".."),
  type: z.enum(["file", "directory"]),
})).max(5000) });

export function MatrixAttachmentPicker({ gatewayUrl, pending, error, close, chooseDevice, select }: {
  gatewayUrl: string;
  pending: boolean;
  error: string | null;
  close: () => void;
  chooseDevice: () => void;
  select: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    gatewayUrl: string;
    path: string;
    entries: z.infer<typeof Entries>["entries"] | null;
  } | null>(null);
  const data = result?.path === path && result.gatewayUrl === gatewayUrl ? result : null;
  const segments = path ? path.split("/") : [];
  const entries = data?.entries?.filter(entry => entry.name.toLowerCase().includes(query.trim().toLowerCase()));
  const navigate = (next: string) => { setQuery(""); setPath(next); };

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
        if (!request.signal.aborted) setResult({ gatewayUrl, path, entries });
      } catch (failure: unknown) {
        if (!request.signal.aborted) {
          console.warn("[chat] Matrix file listing unavailable", failure instanceof Error ? failure.name : "UnknownError");
          setResult({ gatewayUrl, path, entries: null });
        }
      }
    })();
    return () => request.abort();
  }, [attempt, gatewayUrl, path]);

  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="matrix-attachment-picker" showCloseButton={false}
      style={{ zIndex: SHELL_Z_INDEX.appDialog }} overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog - 1 }}>
      <header className="matrix-attachment-picker-header">
        <DialogTitle>Attach files</DialogTitle>
        <DialogDescription className="sr-only">Choose a file from this Matrix Computer.</DialogDescription>
        <DialogClose asChild><button type="button" className="matrix-attachment-icon-button" aria-label="Close"><XIcon size={16} /></button></DialogClose>
      </header>
      <div className="matrix-attachment-picker-content">
        <div className="matrix-attachment-picker-location">
          <FolderIcon size={16} aria-hidden="true" />
          <span className="matrix-attachment-picker-source">Matrix Files</span>
          <span className="matrix-attachment-picker-location-divider" aria-hidden="true" />
          <nav aria-label="Current folder" className="matrix-attachment-picker-breadcrumbs">
            <button type="button" disabled={pending} aria-label="Matrix home" aria-current={!path ? "page" : undefined}
              onClick={() => navigate("")}>Home</button>
            {segments.map((segment, index) => <span key={index}>
              <ChevronRightIcon size={12} aria-hidden="true" />
              <button type="button" disabled={pending} aria-current={index === segments.length - 1 ? "page" : undefined}
                title={segment} onClick={() => navigate(segments.slice(0, index + 1).join("/"))}>{segment}</button>
            </span>)}
          </nav>
          {path ? <button type="button" className="matrix-attachment-icon-button" aria-label="Up" disabled={pending}
            onClick={() => navigate(segments.slice(0, -1).join("/"))}><ArrowLeftIcon size={15} /></button> : null}
        </div>
        <label className="matrix-attachment-picker-search">
          <SearchIcon size={16} aria-hidden="true" />
          <input type="search" aria-label="Search Matrix files" placeholder="Search files…" maxLength={80}
            value={query} disabled={pending} onChange={event => setQuery(event.target.value)} />
        </label>
        <div className="matrix-attachment-picker-list" aria-busy={pending || data === null}>
          {data === null ? <p role="status" className="matrix-attachment-picker-state">Loading files…</p> : data.entries === null ? (
            <div role="alert" className="matrix-attachment-picker-state">Files unavailable.
              <button type="button" className="matrix-attachment-picker-retry" onClick={() => {
                setResult(null);
                setAttempt(value => value + 1);
              }}>Retry</button>
            </div>
          ) : data.entries.length === 0 ? <p className="matrix-attachment-picker-state">This folder is empty.</p>
            : entries?.length === 0 ? <p className="matrix-attachment-picker-state">No files match your search.</p> : (
              <ul>
                {entries?.map(entry => <li key={entry.name}>
                  <button type="button" className="matrix-attachment-picker-row" disabled={pending}
                    aria-label={`${entry.type === "directory" ? "Open" : "Attach"} ${entry.name}`}
                    title={entry.name}
                    onClick={() => {
                      const next = path ? `${path}/${entry.name}` : entry.name;
                      if (!FileResourceRefSchema.safeParse({ kind: "home", path: next }).success) return;
                      if (entry.type === "directory") navigate(next);
                      else select(next);
                    }}>
                    {entry.type === "directory" ? <FolderIcon size={16} aria-hidden="true" /> : <FileIcon size={16} aria-hidden="true" />}
                    <span>{entry.name}</span>
                    {entry.type === "directory" ? <ChevronRightIcon size={14} aria-hidden="true" /> : null}
                  </button>
                </li>)}
              </ul>
            )}
        </div>
        {pending ? <p role="status" className="matrix-attachment-picker-notice">Reading file…</p> : null}
        {error ? <p role="alert" className="matrix-attachment-picker-notice matrix-attachment-picker-error">{error}</p> : null}
      </div>
      <footer className="matrix-attachment-picker-footer">
        <button type="button" className="matrix-attachment-device-button" disabled={pending} onClick={chooseDevice}>
          <UploadIcon size={15} aria-hidden="true" />Upload from device
        </button>
        <button type="button" className="matrix-attachment-cancel-button" onClick={close}>Cancel</button>
      </footer>
    </DialogContent>
  </Dialog>;
}
