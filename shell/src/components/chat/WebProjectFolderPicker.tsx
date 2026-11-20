"use client";

// Directories-only browser of the routed Matrix computer for the add-project
// dialog. Electron Desktop uses its full Files browser in folder-picker mode;
// the choice rules (protected paths, already-connected folders) are shared.
import { folderPickerAction, type AddProjectFolderPickerProps } from "@matrix-os/ui";
import { createContext, useContext, useEffect, useState } from "react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, ChevronRightIcon, FolderIcon, FolderPlus } from "@/lib/hugeicons";

const LIST_TIMEOUT_MS = 10_000;
const Entries = z.object({ entries: z.array(z.object({
  name: z.string().min(1).max(512).refine((value) => !/[\\/]/.test(value) && value !== "." && value !== ".."),
  type: z.enum(["file", "directory"]),
})).max(5000) });

/** The routed computer's gateway, provided by the dialog that hosts the picker. */
export const WebFolderPickerGateway = createContext<string | null>(null);

type Listing = { gatewayUrl: string; path: string; folders: string[] | null };

export function WebProjectFolderPicker({ onChooseFolder, onCreateFolder, resolveFolderChoice, onAlternateFolderAction }: AddProjectFolderPickerProps) {
  const gatewayUrl = useContext(WebFolderPickerGateway);
  const [path, setPath] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const current = listing?.gatewayUrl === gatewayUrl && listing.path === path ? listing : null;
  const segments = path ? path.split("/") : [];
  const action = folderPickerAction(path, resolveFolderChoice);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- folders belong to the routed computer and change with navigation.
  useEffect(() => {
    if (!gatewayUrl) return;
    const request = new AbortController();
    fetch(`${gatewayUrl}/api/files/list?path=${encodeURIComponent(path)}`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]),
    }).then(response => {
      if (!response.ok) throw new Error("FolderUnavailable");
      return response.json();
    }).then((body: unknown) => {
      const folders = Entries.parse(body).entries.filter(entry => entry.type === "directory").map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));
      if (!request.signal.aborted) setListing({ gatewayUrl, path, folders });
    }).catch((cause: unknown) => {
      if (request.signal.aborted) return;
      console.warn("[web-projects] folder listing unavailable", cause instanceof Error ? cause.name : "UnknownError");
      setListing({ gatewayUrl, path, folders: null });
    });
    return () => request.abort();
  }, [attempt, gatewayUrl, path]);

  return <div className="flex flex-col overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
    <div className="flex min-w-0 items-center gap-1 border-b px-2 py-1.5 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
      <button type="button" aria-label="Up" disabled={!path} onClick={() => setPath(segments.slice(0, -1).join("/"))}
        className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-[var(--bg-hover)] disabled:opacity-40">
        <ArrowLeftIcon size={13} aria-hidden="true" />
      </button>
      <nav aria-label="Current folder" className="flex min-w-0 items-center gap-1 overflow-hidden">
        <button type="button" aria-current={!path ? "page" : undefined} onClick={() => setPath("")} className="shrink-0 rounded px-1 hover:bg-[var(--bg-hover)]">Matrix home</button>
        {segments.map((segment, index) => <span key={`${index}/${segment}`} className="flex min-w-0 items-center gap-1">
          <ChevronRightIcon size={11} aria-hidden="true" />
          <button type="button" title={segment} aria-current={index === segments.length - 1 ? "page" : undefined}
            onClick={() => setPath(segments.slice(0, index + 1).join("/"))} className="truncate rounded px-1 hover:bg-[var(--bg-hover)]">{segment}</button>
        </span>)}
      </nav>
    </div>
    <div className="h-[200px] overflow-y-auto p-1" aria-busy={current === null}>
      {current === null ? <p role="status" className="grid h-full place-items-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading folder…</p>
        : current.folders === null ? <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <span role="alert" className="text-sm" style={{ color: "var(--danger-text, var(--destructive))" }}>This folder could not be loaded.</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => { setListing(null); setAttempt(value => value + 1); }}>Try again</Button>
        </div>
        : current.folders.length === 0 ? <p className="grid h-full place-items-center text-xs" style={{ color: "var(--text-tertiary)" }}>No subfolders here.</p>
        : <ul>{current.folders.map(name => <li key={name}>
          <button type="button" aria-label={`Open ${name}`} title={name} onClick={() => setPath(path ? `${path}/${name}` : name)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-primary)" }}>
            <FolderIcon size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <ChevronRightIcon size={13} aria-hidden="true" />
          </button>
        </li>)}</ul>}
    </div>
    <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
      <div className="min-w-0">
        <div className="truncate text-xs" style={{ color: "var(--text-secondary)" }} title={path || "Matrix home"}>{path || "Matrix home"}</div>
        {action.choice && action.choice.kind !== "choose" ? <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>{action.choice.message}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onCreateFolder && action.canCreateFolder ? <Button type="button" size="sm" variant="secondary" aria-label={`New folder in ${path}`} onClick={() => onCreateFolder(path)}>
          <FolderPlus size={13} aria-hidden="true" />New folder here
        </Button> : null}
        <Button type="button" size="sm" disabled={action.disabled} onClick={() => action.choice?.kind === "alternate"
          ? onAlternateFolderAction?.(path) : onChooseFolder(path)}>{action.label}</Button>
      </div>
    </div>
  </div>;
}
