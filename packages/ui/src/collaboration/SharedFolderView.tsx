import {
  CollaborationFileActionResponseSchema,
  CollaborationScopeSchema,
  isSafeCollaborationRelativePath,
  type CollaborationCatalogEntry,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { MAX_SHARED_FOLDER_PAGES, loadSharedFolderPage } from "./shared-folder-paging.js";
import { SHARED_FILE_DOWNLOAD_MAX_BYTES, classifySharedFileFailure, sharedFileName, type SharedFileUnavailableReason } from "./recipient-views.js";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type Loaded = { scope: Scope; entries: CollaborationCatalogEntry[]; nextCursor?: string; pages: number };
type FolderState = { status: "loading" } | { status: "failed"; reason: SharedFileUnavailableReason } | { status: "ready"; data: Loaded };
type Form = { type: "create"; kind: "file" | "folder" } | { type: "rename"; entry: CollaborationCatalogEntry } | null;

const buttonClass = "rounded-xl border px-3 py-2 text-sm hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";
const basePath = (scopeId: string) => `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
const validName = (name: string) => isSafeCollaborationRelativePath(name) && !name.includes("/");
const childPath = (parent: string, name: string) => `${parent}/${name}`;

function saveBytes(bytes: Uint8Array, name: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A folder scope can browse only its catalog root and descendants; the home enforces that boundary again on every request. */
export function SharedFolderView({ api, scopeId }: { api: CollaborationApi; scopeId: string }) {
  const [state, setState] = useState<FolderState>({ status: "loading" });
  const [folderId, setFolderId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const generation = useRef(0);
  const selectedFolder = useRef<string | null>(null);
  const loadedPages = useRef(1);
  const selectFolder = (id: string | null) => { selectedFolder.current = id; setFolderId(id); setForm(null); };

  const load = useCallback(async () => {
    const current = ++generation.current;
    const targetFolder = selectedFolder.current;
    const minimumPages = loadedPages.current;
    setState({ status: "loading" });
    try {
      const scope = CollaborationScopeSchema.parse(await api.get(basePath(scopeId)));
      if (scope.kind !== "folder") throw new Error("Scope kind mismatch");
      const first = await loadSharedFolderPage(api.get, scopeId);
      if (!first.entries.some((entry) => entry.id === scope.resourceId && entry.kind === "folder")) throw new Error("Shared folder root unavailable");
      const entries = [...first.entries];
      let nextCursor = first.nextCursor;
      let pages = 1;
      const seen = new Set<string>();
      while (nextCursor && pages < MAX_SHARED_FOLDER_PAGES &&
        (pages < minimumPages || (targetFolder !== null && !entries.some((entry) => entry.id === targetFolder && entry.kind === "folder")))) {
        if (seen.has(nextCursor)) throw new Error("CollaborationFolderCursorLoop");
        seen.add(nextCursor);
        const page = await loadSharedFolderPage(api.get, scopeId, nextCursor);
        entries.push(...page.entries.filter((entry) => !entries.some((old) => old.id === entry.id)));
        nextCursor = page.nextCursor;
        pages += 1;
      }
      if (current === generation.current) {
        loadedPages.current = pages;
        setState({ status: "ready", data: { scope, entries, nextCursor, pages } });
      }
    } catch (error: unknown) {
      if (current !== generation.current) return;
      console.warn("[shared-folder] load failed", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "failed", reason: classifySharedFileFailure(error) });
    }
  }, [api, scopeId]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- direct home read, fenced by generation.
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);

  if (state.status === "loading") return <p role="status" className="p-8">Loading shared folder…</p>;
  if (state.status === "failed") return <main className="mx-auto max-w-xl p-8">
    <h1 className="text-xl font-semibold">Shared folder unavailable</h1>
    <p className="mt-2">{state.reason === "host_offline" ? "The owner's computer is offline. Try again later." : state.reason === "access_removed" ? "Your access may have changed." : "This folder is temporarily unavailable."}</p>
    {state.reason !== "access_removed" && <button type="button" className={buttonClass} onClick={() => void load()}>Try again</button>}
  </main>;

  const { scope, entries, nextCursor, pages } = state.data;
  const root = entries.find((entry) => entry.id === scope.resourceId)!;
  const current = folderId === null ? root : entries.find((entry) => entry.id === folderId && entry.kind === "folder");
  if (!current) return <main className="ph-no-capture mx-auto max-w-xl p-8">
    <h1 className="text-xl font-semibold">Folder no longer available</h1>
    <p className="mt-2">The folder may have moved or your access may have changed.</p>
    <button type="button" className={buttonClass} onClick={() => selectFolder(null)}>Back to shared root</button>
  </main>;
  const children = entries.filter((entry) => entry.parentId === current.id);
  const canEdit = scope.role !== "viewer";
  const setEntries = (update: (value: Loaded) => Loaded) => setState((value) => value.status === "ready" ? { status: "ready", data: update(value.data) } : value);

  const loadMore = async () => {
    if (!nextCursor || busy || pages >= MAX_SHARED_FOLDER_PAGES) return;
    const request = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      const page = await loadSharedFolderPage(api.get, scopeId, nextCursor);
      if (request !== generation.current) return;
      loadedPages.current = pages + 1;
      setEntries((value) => ({ ...value, entries: [...value.entries, ...page.entries.filter((entry) => !value.entries.some((old) => old.id === entry.id))], nextCursor: page.nextCursor, pages: value.pages + 1 }));
    } catch (error: unknown) {
      if (request !== generation.current) return;
      console.warn("[shared-folder] page failed", error instanceof Error ? error.name : "UnknownError");
      setActionError("More files could not be loaded. Try again.");
    } finally { if (request === generation.current) setBusy(false); }
  };

  const submit = async () => {
    const nextName = name.trim();
    if (!form || !validName(nextName) || busy) { setActionError("Choose a single valid name."); return; }
    const parent = form.type === "rename"
      ? entries.find((entry) => entry.id === form.entry.parentId)
      : current;
    if (!parent) { setActionError("This folder changed. Refresh and try again."); return; }
    const path = childPath(parent.path, nextName);
    const request = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      const body = form.type === "create"
        ? { type: "create", kind: form.kind, parentId: current.id, path, ...(form.kind === "file" ? { content: "" } : {}), clientRequestId: crypto.randomUUID() }
        : { type: "rename", fileId: form.entry.id, path, expectedRevision: form.entry.revision, clientRequestId: crypto.randomUUID() };
      const result = CollaborationFileActionResponseSchema.parse(await api.post(`${basePath(scopeId)}/files/actions`, body));
      if (request !== generation.current) return;
      if (!result.entry) throw new Error("Missing catalog entry");
      setForm(null);
      setName("");
      setBusy(false);
      await load();
    } catch (error: unknown) {
      if (request !== generation.current) return;
      console.warn("[shared-folder] mutation failed", error instanceof Error ? error.name : "UnknownError");
      setActionError("The change could not be saved. Refresh and try again.");
    } finally { if (request === generation.current) setBusy(false); }
  };

  const remove = async (entry: CollaborationCatalogEntry) => {
    if (busy || !window.confirm(`Delete ${sharedFileName(entry.path)}?`)) return;
    const request = generation.current;
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`${basePath(scopeId)}/files/actions`, {
        type: "delete", fileId: entry.id, expectedRevision: entry.revision, clientRequestId: crypto.randomUUID(),
      });
      if (request !== generation.current) return;
      if (entry.id === selectedFolder.current) selectFolder(entry.parentId);
      setBusy(false);
      await load();
    } catch (error: unknown) {
      if (request !== generation.current) return;
      console.warn("[shared-folder] delete failed", error instanceof Error ? error.name : "UnknownError");
      setActionError("The item could not be deleted. Refresh and try again.");
    } finally { if (request === generation.current) setBusy(false); }
  };

  const download = async (entry: CollaborationCatalogEntry) => {
    const request = generation.current;
    setDownloadError(null);
    try {
      if (!api.getContent) throw new Error("Content unavailable");
      const content = await api.getContent(`${basePath(scopeId)}/files/${encodeURIComponent(entry.id)}/content`, { maxBytes: SHARED_FILE_DOWNLOAD_MAX_BYTES });
      if (request !== generation.current) return;
      if (content.status === "too_large") { setDownloadError("This file is too large to download here."); return; }
      saveBytes(content.bytes, sharedFileName(entry.path), content.contentType);
    } catch (error: unknown) {
      if (request !== generation.current) return;
      console.warn("[shared-folder] download failed", error instanceof Error ? error.name : "UnknownError");
      setDownloadError("The file could not be downloaded. Try again.");
    }
  };

  return <main data-slot="shared-folder-view" className="ph-no-capture mx-auto flex min-h-full w-full max-w-4xl flex-col gap-4 p-5 sm:p-8">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs uppercase tracking-widest text-muted-foreground">Shared folder · {canEdit ? "Contributor" : "Viewer"}</p>
        <h1 className="mt-1 break-words text-2xl font-semibold">{sharedFileName(current.path)}</h1></div>
      <button type="button" className={buttonClass} onClick={() => void load()} disabled={busy}>Refresh</button>
    </header>
    {current.id !== root.id && <button type="button" className={`${buttonClass} self-start`} onClick={() => selectFolder(current.parentId)}>Back to parent</button>}
    {actionError && <p role="alert">{actionError}</p>}
    {downloadError && <p role="alert">{downloadError}</p>}
    {canEdit && <div className="flex gap-2">
      <button type="button" className={buttonClass} onClick={() => { setName(""); setForm({ type: "create", kind: "folder" }); }}>New folder</button>
      <button type="button" className={buttonClass} onClick={() => { setName(""); setForm({ type: "create", kind: "file" }); }}>New file</button>
    </div>}
    {form && <div className="flex flex-wrap items-end gap-2">
      <label className="text-sm">{form.type === "create" ? `New ${form.kind} name` : `Rename ${form.entry.kind}`}
        <input type="text" value={name} maxLength={255} onChange={(event) => setName(event.target.value)} className="mt-1 block rounded-xl border bg-transparent px-3 py-2" />
      </label>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void submit()}>{form.type === "create" ? `Create ${form.kind}` : "Save name"}</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => setForm(null)}>Cancel</button>
    </div>}
    {children.length === 0 && <p className="text-muted-foreground">No items here yet. {nextCursor ? "Load more to see the rest." : ""}</p>}
    <ul className="divide-y rounded-2xl border">{children.map((entry) => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
      {entry.kind === "folder" ? <button type="button" className="min-w-0 truncate text-left font-medium" onClick={() => selectFolder(entry.id)}>{sharedFileName(entry.path)}</button>
        : <span className="min-w-0 truncate">{sharedFileName(entry.path)}</span>}
      <div className="flex flex-wrap gap-2">
        {entry.kind === "file" && <button type="button" className={buttonClass} onClick={() => void download(entry)}>Download {sharedFileName(entry.path)}</button>}
        {canEdit && <><button type="button" className={buttonClass} disabled={busy} onClick={() => { setName(sharedFileName(entry.path)); setForm({ type: "rename", entry }); }}>Rename {sharedFileName(entry.path)}</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void remove(entry)}>Delete {sharedFileName(entry.path)}</button></>}
      </div>
    </li>)}</ul>
    {nextCursor && pages < MAX_SHARED_FOLDER_PAGES && <button type="button" className={`${buttonClass} self-start`} disabled={busy} onClick={() => void loadMore()}>Load more</button>}
    {nextCursor && pages >= MAX_SHARED_FOLDER_PAGES && <p role="status">Showing the first {MAX_SHARED_FOLDER_PAGES * 100} items. Refresh to see recent changes.</p>}
  </main>;
}
