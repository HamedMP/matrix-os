import {
  CollaborationFileActionResponseSchema,
  CollaborationFileListResponseSchema,
  CollaborationScopeSchema,
  type CollaborationCatalogEntry,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import {
  SHARED_FILE_DOWNLOAD_MAX_BYTES,
  SHARED_FILE_EDIT_MAX_BYTES,
  SHARED_FILE_PREVIEW_MAX_BYTES,
  classifySharedFileFailure,
  decodeSharedFileText,
  sharedFileCopyName,
  sharedFileFailureCode,
  sharedFileName,
  type SharedFileUnavailableReason,
} from "./recipient-views.js";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type Preview =
  | { kind: "text"; text: string; bytes: Uint8Array; contentType: string }
  | { kind: "binary"; bytes: Uint8Array; contentType: string }
  | { kind: "too_large" };
interface SharedFile { entry: CollaborationCatalogEntry; preview: Preview }
type FileState =
  | { status: "loading" }
  | { status: "failed"; reason: SharedFileUnavailableReason }
  | { status: "no_content" }
  | { status: "ready"; scope: Scope; file: SharedFile };
interface Conflict { text: string | null; file: SharedFile }
type Notice = { kind: "saved" } | { kind: "error"; message: string } | null;

class ResourceMissing extends Error {
  constructor() { super("Shared file is missing"); this.name = "ResourceMissing"; }
}

const ROLE_LABEL = { owner: "Owner", editor: "Contributor", viewer: "Viewer" } as const;
const buttonClass = "rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

function scopePath(scopeId: string): string {
  return `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
}

function contentPath(scopeId: string, fileId: string): string {
  return `${scopePath(scopeId)}/files/${encodeURIComponent(fileId)}/content`;
}

function saveBytes(bytes: Uint8Array | string, name: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function textPreview(text: string, contentType: string): Preview {
  return { kind: "text", text, bytes: new TextEncoder().encode(text), contentType };
}

/** The file entry of a file scope and a bounded preview of its bytes. */
async function readSharedFile(api: CollaborationApi, scopeId: string): Promise<SharedFile> {
  const page = CollaborationFileListResponseSchema.parse(await api.get(`${scopePath(scopeId)}/files?limit=1`));
  const entry = page.entries.find((candidate) => candidate.kind === "file");
  if (!entry || !api.getContent) throw new ResourceMissing();
  let content;
  try {
    content = await api.getContent(contentPath(scopeId, entry.id), { maxBytes: SHARED_FILE_PREVIEW_MAX_BYTES });
  } catch (error: unknown) {
    if (sharedFileFailureCode(error) === "not_found") throw new ResourceMissing();
    throw error;
  }
  if (content.status === "too_large") return { entry, preview: { kind: "too_large" } };
  const text = decodeSharedFileText(content.bytes, content.contentType);
  return {
    entry,
    preview: text === null ? { kind: "binary", bytes: content.bytes, contentType: content.contentType } : textPreview(text, content.contentType),
  };
}

function saveFailureMessage(error: unknown): string {
  const reason = classifySharedFileFailure(error);
  if (reason === "host_offline") return "Your changes were not saved. The owner's computer is offline.";
  if (reason === "access_removed") return "Your changes were not saved. Your access may have changed.";
  return "Your changes were not saved. Try again.";
}

/**
 * Spec 535 D6: a shared file opens in its own view. Text up to 1 MiB previews;
 * everything downloads; Contributors edit text against the revision they read,
 * and a conflict keeps their text beside the owner's version, never overwriting.
 */
export function SharedFileView({ api, scopeId }: { api: CollaborationApi; scopeId: string }) {
  const [state, setState] = useState<FileState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setState({ status: "loading" });
    try {
      const scope = CollaborationScopeSchema.parse(await api.get(scopePath(scopeId)));
      if (scope.kind !== "file") throw new Error("Scope kind mismatch");
      if (!api.getContent) {
        if (current === generation.current) setState({ status: "no_content" });
        return;
      }
      const file = await readSharedFile(api, scopeId);
      if (current === generation.current) setState({ status: "ready", scope, file });
    } catch (error: unknown) {
      if (current !== generation.current) return;
      if (!(error instanceof ResourceMissing)) console.warn("[shared-file] load failed", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "failed", reason: error instanceof ResourceMissing ? "resource_missing" : classifySharedFileFailure(error) });
    }
  }, [api, scopeId]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- loads the shared file from its home through the collaboration API; stale results are fenced by the generation counter.
  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  if (state.status === "loading") return <p role="status" className="p-8">Loading shared file…</p>;
  if (state.status === "no_content") return <FileMessage title="Shared file" body="Files can’t be opened in this version of Matrix." />;
  if (state.status === "failed") return <SharedFileFailure reason={state.reason} retry={() => void load()} />;
  return <SharedFileEditor key={state.file.entry.id} api={api} scopeId={scopeId} scope={state.scope} initial={state.file} />;
}

function SharedFileFailure({ reason, retry }: { reason: SharedFileUnavailableReason; retry: () => void }) {
  if (reason === "access_removed") {
    return <FileMessage title="Shared file unavailable" body="Your access may have changed. Return to Shared with me and refresh." />;
  }
  if (reason === "resource_missing") return <FileMessage title="Shared file" body="This file was moved or deleted by its owner." />;
  return <FileMessage
    title="Shared file"
    body={reason === "host_offline" ? "The owner's computer is offline. Try again later." : "This file is temporarily unavailable."}
    action={<button type="button" className={buttonClass} onClick={retry}>Try again</button>}
  />;
}

function SharedFileEditor({ api, scopeId, scope, initial }: {
  api: CollaborationApi;
  scopeId: string;
  scope: Scope;
  initial: SharedFile;
}) {
  const [file, setFile] = useState(initial);
  const [draft, setDraft] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const saveRequest = useRef<{ key: string; id: string } | null>(null);
  const { entry, preview } = file;
  const name = sharedFileName(entry.path);
  const canEdit = scope.role !== "viewer" && preview.kind === "text" && preview.bytes.byteLength <= SHARED_FILE_EDIT_MAX_BYTES;

  const download = async () => {
    setNotice(null);
    if (preview.kind !== "too_large") {
      saveBytes(preview.bytes, name, preview.contentType);
      return;
    }
    try {
      const content = await api.getContent!(contentPath(scopeId, entry.id), { maxBytes: SHARED_FILE_DOWNLOAD_MAX_BYTES });
      if (content.status === "too_large") {
        setNotice({ kind: "error", message: "This file is too large to download here." });
        return;
      }
      saveBytes(content.bytes, name, content.contentType);
    } catch (error: unknown) {
      console.warn("[shared-file] download failed", error instanceof Error ? error.name : "UnknownError");
      setNotice({ kind: "error", message: "The file could not be downloaded. Try again." });
    }
  };

  /** A write the home rejected is a conflict when the home now holds a newer revision. */
  const findConflict = async (): Promise<Conflict | null> => {
    try {
      const latest = await readSharedFile(api, scopeId);
      if (latest.entry.revision === entry.revision) return null;
      return { text: latest.preview.kind === "text" ? latest.preview.text : null, file: latest };
    } catch (error: unknown) {
      console.warn("[shared-file] conflict check failed", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  };

  const save = async () => {
    if (draft === null || saving) return;
    const key = `${entry.revision}:${draft}`;
    if (saveRequest.current?.key !== key) saveRequest.current = { key, id: crypto.randomUUID() };
    setSaving(true);
    setNotice(null);
    try {
      const result = CollaborationFileActionResponseSchema.parse(await api.post(`${scopePath(scopeId)}/files/actions`, {
        type: "write", fileId: entry.id, content: draft, expectedRevision: entry.revision, clientRequestId: saveRequest.current.id,
      }));
      setFile({ entry: result.entry ?? entry, preview: textPreview(draft, preview.kind === "too_large" ? "text/plain" : preview.contentType) });
      setDraft(null);
      setNotice({ kind: "saved" });
    } catch (error: unknown) {
      const code = sharedFileFailureCode(error);
      console.warn("[shared-file] save failed", code ?? (error instanceof Error ? error.name : "UnknownError"));
      const found = code === "invalid_request" ? await findConflict() : null;
      if (found) setConflict(found);
      else setNotice({ kind: "error", message: saveFailureMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  // Explicit resolution either way; nothing is written until the Contributor saves again.
  const keepMyEdits = (resolved: Conflict) => {
    setFile(resolved.file);
    setConflict(null);
  };
  const takeOwnerVersion = (resolved: Conflict) => {
    setFile(resolved.file);
    setConflict(null);
    setDraft(null);
  };

  return <main data-slot="shared-file-view" className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-4 p-5 sm:p-8">
    <header className="flex flex-wrap items-start gap-3">
      <div className="min-w-0" style={{ flex: "1 1 15rem" }}>
        <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>Shared file</p>
        <h1 className="mt-1 break-words text-2xl font-semibold">{name}</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{ROLE_LABEL[scope.role]}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {canEdit && draft === null && preview.kind === "text"
          ? <button type="button" className={buttonClass} onClick={() => { setNotice(null); setDraft(preview.text); }}>Edit</button> : null}
        {draft !== null && conflict === null ? <>
          <button type="button" className={buttonClass} disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          <button type="button" className={buttonClass} disabled={saving} onClick={() => { setDraft(null); setNotice(null); }}>Cancel</button>
        </> : null}
        <button type="button" className={buttonClass} onClick={() => void download()}>Download</button>
      </div>
    </header>
    {notice?.kind === "saved" ? <p role="status" className="text-sm">Saved</p> : null}
    {notice?.kind === "error" ? <p role="alert" className="text-sm">{notice.message}</p> : null}
    {conflict ? <ConflictPanel conflict={conflict} onKeep={() => keepMyEdits(conflict)} onTakeOwner={() => takeOwnerVersion(conflict)}
      onDownloadMine={() => saveBytes(draft ?? "", sharedFileCopyName(name), "text/plain")} /> : null}
    {draft !== null ? <>
      {conflict ? <p className="text-sm font-medium">Your version</p> : null}
      <textarea aria-label="File contents" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false}
        className="w-full rounded-2xl border bg-transparent p-4 font-mono text-sm" style={{ minHeight: conflict ? "30vh" : "50vh" }} />
    </>
      : <FilePreview preview={preview} showEditLimit={scope.role !== "viewer" && !canEdit} />}
  </main>;
}

function ConflictPanel({ conflict, onKeep, onTakeOwner, onDownloadMine }: {
  conflict: Conflict;
  onKeep: () => void;
  onTakeOwner: () => void;
  onDownloadMine: () => void;
}) {
  return <section className="rounded-2xl border p-4">
    <p role="alert" className="font-medium">The owner changed this file while you were editing.</p>
    <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Your text is kept below. Nothing was overwritten.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={buttonClass} onClick={onKeep}>Keep my edits</button>
      <button type="button" className={buttonClass} onClick={onTakeOwner}>Use the owner's version</button>
      <button type="button" className={buttonClass} onClick={onDownloadMine}>Download my version</button>
    </div>
    <p className="mt-3 text-sm font-medium">Owner's version</p>
    <section aria-label="Owner's version" className="mt-1 overflow-auto rounded-xl border p-3" style={{ maxHeight: "20rem" }}>
      {conflict.text === null
        ? <p className="text-sm">The owner's version can't be shown here. Download it to compare.</p>
        : <pre className="whitespace-pre-wrap break-words text-sm">{conflict.text}</pre>}
    </section>
  </section>;
}

function FilePreview({ preview, showEditLimit }: { preview: Preview; showEditLimit: boolean }) {
  if (preview.kind !== "text") {
    return <FileMessage
      title=""
      body={preview.kind === "too_large" ? "This file is too large to preview. Download it to open it." : "No preview for this type of file. Download it to open it."}
    />;
  }
  return <>
    {showEditLimit ? <p className="text-sm" style={{ color: "var(--text-secondary)" }}>This file is too large to edit here. Download it to edit it.</p> : null}
    <pre aria-label="File preview" className="overflow-auto whitespace-pre-wrap break-words rounded-2xl border p-4 font-mono text-sm" style={{ maxHeight: "70vh" }}>{preview.text}</pre>
  </>;
}

function FileMessage({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="m-auto max-w-lg rounded-2xl border p-8 text-center">
    <div aria-hidden className="text-3xl">◇</div>
    {title ? <h1 className="mt-3 text-lg font-medium">{title}</h1> : null}
    <p className="mt-1 text-sm">{body}</p>
    {action ? <div className="mt-4">{action}</div> : null}
  </div>;
}
