"use client";

// Directories-only browser of the routed Matrix computer for the add-project
// dialog. Electron Desktop uses its full Files browser in folder-picker mode;
// the choice rules (protected paths, already-connected folders) are shared.
import { folderPickerAction, type AddProjectFolderPickerProps } from "@matrix-os/ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, ChevronRightIcon, FolderIcon, FolderPlus } from "@/lib/hugeicons";
import { WebFolderPickerGateway } from "./web-folder-picker-gateway";

const LIST_TIMEOUT_MS = 10_000;
const Entries = z.object({ entries: z.array(z.object({
  name: z.string().min(1).max(512).refine((value) => !/[\\/]/.test(value) && value !== "." && value !== ".."),
  type: z.enum(["file", "directory"]),
})).max(5000) });

type Listing = { gatewayUrl: string; path: string; folders: string[] | null };

/** The subfolders of `path`, or null after a failed load; undefined while loading. */
function useFolderListing(gatewayUrl: string | null, path: string) {
  const [attempt, setAttempt] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
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
  const current = listing?.gatewayUrl === gatewayUrl && listing.path === path ? listing : null;
  return { folders: current ? current.folders : undefined, retry: () => { setListing(null); setAttempt(value => value + 1); } };
}

function FolderBreadcrumbs({ path, onNavigate }: { path: string; onNavigate(path: string): void }) {
  const segments = path ? path.split("/") : [];
  return <div className="flex min-w-0 items-center gap-1 border-b px-2 py-1.5 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
    <button type="button" aria-label="Up" disabled={!path} onClick={() => onNavigate(segments.slice(0, -1).join("/"))}
      className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-[var(--bg-hover)] disabled:opacity-40">
      <ArrowLeftIcon size={13} aria-hidden="true" />
    </button>
    <nav aria-label="Current folder" className="flex min-w-0 items-center gap-1 overflow-hidden">
      <button type="button" aria-current={!path ? "page" : undefined} onClick={() => onNavigate("")} className="shrink-0 rounded px-1 hover:bg-[var(--bg-hover)]">Matrix home</button>
      {segments.map((segment, index) => {
        const target = segments.slice(0, index + 1).join("/");
        return <span key={target} className="flex min-w-0 items-center gap-1">
          <ChevronRightIcon size={11} aria-hidden="true" />
          <button type="button" title={segment} aria-current={index === segments.length - 1 ? "page" : undefined}
            onClick={() => onNavigate(target)} className="truncate rounded px-1 hover:bg-[var(--bg-hover)]">{segment}</button>
        </span>;
      })}
    </nav>
  </div>;
}

function FolderList({ folders, onOpen, onRetry }: { folders: string[] | null | undefined; onOpen(name: string): void; onRetry(): void }) {
  if (folders === undefined) return <p role="status" className="grid h-full place-items-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading folder…</p>;
  if (folders === null) return <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
    <span role="alert" className="text-sm" style={{ color: "var(--danger-text, var(--destructive))" }}>This folder could not be loaded.</span>
    <Button type="button" size="sm" variant="secondary" onClick={onRetry}>Try again</Button>
  </div>;
  if (folders.length === 0) return <p className="grid h-full place-items-center text-xs" style={{ color: "var(--text-tertiary)" }}>No subfolders here.</p>;
  return <ul>{folders.map(name => <li key={name}>
    <button type="button" aria-label={`Open ${name}`} title={name} onClick={() => onOpen(name)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-primary)" }}>
      <FolderIcon size={15} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <ChevronRightIcon size={13} aria-hidden="true" />
    </button>
  </li>)}</ul>;
}

export function WebProjectFolderPicker({ onChooseFolder, onCreateFolder, resolveFolderChoice, onAlternateFolderAction }: AddProjectFolderPickerProps) {
  const gatewayUrl = useContext(WebFolderPickerGateway);
  const [path, setPath] = useState("");
  const { folders, retry } = useFolderListing(gatewayUrl, path);
  const action = folderPickerAction(path, resolveFolderChoice);
  const message = action.choice && action.choice.kind !== "choose" ? action.choice.message : undefined;

  return <div className="flex flex-col overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
    <FolderBreadcrumbs path={path} onNavigate={setPath} />
    <div className="h-[200px] overflow-y-auto p-1" aria-busy={folders === undefined}>
      <FolderList folders={folders} onRetry={retry} onOpen={name => setPath(path ? `${path}/${name}` : name)} />
    </div>
    <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}>
      <div className="min-w-0">
        <div className="truncate text-xs" style={{ color: "var(--text-secondary)" }} title={path || "Matrix home"}>{path || "Matrix home"}</div>
        {message ? <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>{message}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onCreateFolder && action.canCreateFolder ? <Button type="button" size="sm" variant="secondary" aria-label={`New folder in ${path}`} onClick={() => onCreateFolder(path)}>
          <FolderPlus size={13} aria-hidden="true" />New folder here
        </Button> : null}
        <Button type="button" size="sm" disabled={action.disabled}
          onClick={() => action.choice?.kind === "alternate" ? onAlternateFolderAction?.(path) : onChooseFolder(path)}>{action.label}</Button>
      </div>
    </div>
  </div>;
}
