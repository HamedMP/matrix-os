import {
  CollaborationFileActionResponseSchema,
  CollaborationFileListResponseSchema,
  CollaborationCatalogEntrySchema,
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

/** `bytes` are what the home holds (or what a save just wrote), never a re-encoding of a lossy decode. */
function textPreview(text: string, contentType: string, bytes: Uint8Array = new TextEncoder().encode(text)): Preview {
  return { kind: "text", text, bytes, contentType };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The file entry of a file scope and a bounded preview of its bytes. */
async function readSharedFile(api: CollaborationApi, scopeId: string, fileId?: string): Promise<SharedFile> {
  let listed: unknown;
  try {
    listed = await api.get(fileId ? `${scopePath(scopeId)}/files/${encodeURIComponent(fileId)}` : `${scopePath(scopeId)}/files?limit=1`);
  } catch (error: unknown) {
    // The scope itself was just authorized; a missing listing means the owner moved or deleted the file.
    if (sharedFileFailureCode(error) === "not_found") throw new ResourceMissing();
    throw error;
  }
  const entry = fileId ? CollaborationCatalogEntrySchema.parse(listed)
    : CollaborationFileListResponseSchema.parse(listed).entries.find((candidate) => candidate.kind === "file");
  if (!entry || entry.kind !== "file" || !api.getContent) throw new ResourceMissing();
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
    preview: text === null
      ? { kind: "binary", bytes: content.bytes, contentType: content.contentType }
      : textPreview(text, content.contentType, content.bytes),
  };
}

function saveFailureMessage(error: unknown): string {
  const reason = classifySharedFileFailure(error);
  if (reason === "host_offline") return "Your changes were not saved. The owner's computer is offline.";
  if (reason === "access_removed") return "Your changes were not saved. Your access may have changed.";
  return "Your changes were not saved. Try again.";
}

/** Downloads the previewed bytes, or reads them bounded when the preview held none; returns an error notice or null. */
async function downloadSharedFile(api: CollaborationApi, scopeId: string, file: SharedFile): Promise<Notice> {
  const name = sharedFileName(file.entry.path);
  if (file.preview.kind !== "too_large") {
    saveBytes(file.preview.bytes, name, file.preview.contentType);
    return null;
  }
  try {
    const content = await api.getContent!(contentPath(scopeId, file.entry.id), { maxBytes: SHARED_FILE_DOWNLOAD_MAX_BYTES });
    if (content.status === "too_large") return { kind: "error", message: "This file is too large to download here." };
    saveBytes(content.bytes, name, content.contentType);
    return null;
  } catch (error: unknown) {
    console.warn("[shared-file] download failed", error instanceof Error ? error.name : "UnknownError");
    return { kind: "error", message: "The file could not be downloaded. Try again." };
  }
}

/** A write the home rejected is a conflict when the home now holds a newer revision. */
async function findSharedFileConflict(api: CollaborationApi, scopeId: string, readRevision: string, fileId?: string): Promise<Conflict | null> {
  try {
    const latest = await readSharedFile(api, scopeId, fileId);
    if (latest.entry.revision === readRevision) return null;
    return { text: latest.preview.kind === "text" ? latest.preview.text : null, file: latest };
  } catch (error: unknown) {
    console.warn("[shared-file] conflict check failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

type SaveOutcome = { kind: "saved"; file: SharedFile } | { kind: "conflict"; conflict: Conflict } | { kind: "failed"; message: string };

/** Writes `draft` conditional on the revision it was based on; never retries over a newer revision. */
async function saveSharedFileDraft(api: CollaborationApi, scopeId: string, file: SharedFile, draft: string, clientRequestId: string, fileId?: string): Promise<SaveOutcome> {
  try {
    const result = CollaborationFileActionResponseSchema.parse(await api.post(`${scopePath(scopeId)}/files/actions`, {
      type: "write", fileId: file.entry.id, content: draft, expectedRevision: file.entry.revision, clientRequestId,
    }));
    const contentType = file.preview.kind === "too_large" ? "text/plain" : file.preview.contentType;
    return { kind: "saved", file: { entry: result.entry ?? file.entry, preview: textPreview(draft, contentType) } };
  } catch (error: unknown) {
    const code = sharedFileFailureCode(error);
    console.warn("[shared-file] save failed", code ?? (error instanceof Error ? error.name : "UnknownError"));
    const conflict = code === "invalid_request" ? await findSharedFileConflict(api, scopeId, file.entry.revision, fileId) : null;
    return conflict ? { kind: "conflict", conflict } : { kind: "failed", message: saveFailureMessage(error) };
  }
}

/**
 * Spec 535 D6: a shared file opens in its own view. Text up to 1 MiB previews;
 * everything downloads; Contributors edit text against the revision they read,
 * and a conflict keeps their text beside the owner's version, never overwriting.
 */
export function SharedFileView({ api, scopeId, fileId }: { api: CollaborationApi; scopeId: string; fileId?: string }) {
  const [state, setState] = useState<FileState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setState({ status: "loading" });
    try {
      const scope = CollaborationScopeSchema.parse(await api.get(scopePath(scopeId)));
      if (scope.kind !== "file" && !(scope.kind === "project" && fileId)) throw new Error("Scope kind mismatch");
      if (!api.getContent) {
        if (current === generation.current) setState({ status: "no_content" });
        return;
      }
      const file = await readSharedFile(api, scopeId, fileId);
      if (current === generation.current) setState({ status: "ready", scope, file });
    } catch (error: unknown) {
      if (current !== generation.current) return;
      if (!(error instanceof ResourceMissing)) console.warn("[shared-file] load failed", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "failed", reason: error instanceof ResourceMissing ? "resource_missing" : classifySharedFileFailure(error) });
    }
  }, [api, scopeId, fileId]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- loads the shared file from its home through the collaboration API; stale results are fenced by the generation counter.
  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  if (state.status === "loading") return <p role="status" className="p-8">Loading shared file…</p>;
  if (state.status === "no_content") return <FileMessage title="Shared file" body="Files can’t be opened in this version of Matrix." />;
  if (state.status === "failed") return <SharedFileFailure reason={state.reason} retry={() => void load()} />;
  return <SharedFileEditor key={state.file.entry.id} api={api} scopeId={scopeId} scope={state.scope} initial={state.file} fileId={fileId} />;
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

function SharedFileEditor({ api, scopeId, scope, initial, fileId }: {
  api: CollaborationApi;
  scopeId: string;
  scope: Scope;
  initial: SharedFile;
  fileId?: string;
}) {
  const [file, setFile] = useState(initial);
  const [draft, setDraft] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<Notice>(null);
  const [downloadNotice, setDownloadNotice] = useState<Notice>(null);
  const saveRequest = useRef<{ key: string; id: string } | null>(null);
  const { entry, preview } = file;
  const name = sharedFileName(entry.path);
  const canEdit = scope.role !== "viewer" && preview.kind === "text" && preview.bytes.byteLength <= SHARED_FILE_EDIT_MAX_BYTES;
  const draftTooLarge = draft !== null && byteLength(draft) > SHARED_FILE_EDIT_MAX_BYTES;

  const download = async () => {
    setDownloadNotice(null);
    setDownloadNotice(await downloadSharedFile(api, scopeId, file));
  };

  const save = async () => {
    if (draft === null || saving || draftTooLarge) return;
    const key = `${entry.revision}:${draft}`;
    if (saveRequest.current?.key !== key) saveRequest.current = { key, id: crypto.randomUUID() };
    setSaving(true);
    setSaveNotice(null);
    try {
      const outcome = await saveSharedFileDraft(api, scopeId, file, draft, saveRequest.current.id, fileId);
      if (outcome.kind === "saved") {
        setFile(outcome.file);
        setDraft(null);
        setSaveNotice({ kind: "saved" });
      } else if (outcome.kind === "conflict") {
        setConflict(outcome.conflict);
      } else {
        setSaveNotice({ kind: "error", message: outcome.message });
      }
    } finally {
      setSaving(false);
    }
  };

  // Explicit resolution either way; nothing is written until the Contributor saves again.
  const resolveConflict = (resolved: Conflict, keepDraft: boolean) => {
    setFile(resolved.file);
    setConflict(null);
    if (!keepDraft) setDraft(null);
  };
  const toggleEditing = (open: boolean) => {
    setSaveNotice(null);
    setDownloadNotice(null);
    setDraft(open && preview.kind === "text" ? preview.text : null);
  };

  return <main data-slot="shared-file-view" className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-4 p-5 sm:p-8">
    <FileHeader name={name} role={scope.role}>
      <FileActions canEdit={canEdit} draftOpen={draft !== null} editing={draft !== null && conflict === null} saving={saving}
        saveBlocked={draftTooLarge} onEdit={() => toggleEditing(true)} onSave={() => void save()} onCancel={() => toggleEditing(false)}
        onDownload={() => void download()} />
    </FileHeader>
    <FileNotice notice={saveNotice} />
    <FileNotice notice={downloadNotice} />
    {conflict ? <ConflictPanel conflict={conflict} onKeep={() => resolveConflict(conflict, true)} onTakeOwner={() => resolveConflict(conflict, false)}
      onDownloadMine={() => saveBytes(draft ?? "", sharedFileCopyName(name), "text/plain")} /> : null}
    {draft !== null
      ? <DraftEditor draft={draft} onChange={setDraft} saving={saving} tooLarge={draftTooLarge} inConflict={conflict !== null} />
      : <FilePreview preview={preview} showEditLimit={scope.role !== "viewer" && !canEdit} />}
  </main>;
}

function FileActions({ canEdit, draftOpen, editing, saving, saveBlocked, onEdit, onSave, onCancel, onDownload }: {
  canEdit: boolean;
  draftOpen: boolean;
  editing: boolean;
  saving: boolean;
  saveBlocked: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDownload: () => void;
}) {
  return <>
    {canEdit && !draftOpen ? <button type="button" className={buttonClass} onClick={onEdit}>Edit</button> : null}
    {editing ? <button type="button" className={buttonClass} disabled={saving || saveBlocked} onClick={onSave}>{saving ? "Saving…" : "Save"}</button> : null}
    {editing ? <button type="button" className={buttonClass} disabled={saving} onClick={onCancel}>Cancel</button> : null}
    <button type="button" className={buttonClass} onClick={onDownload}>Download</button>
  </>;
}

function FileNotice({ notice }: { notice: Notice }) {
  if (notice?.kind === "saved") return <p role="status" className="text-sm">Saved</p>;
  if (notice?.kind === "error") return <p role="alert" className="text-sm">{notice.message}</p>;
  return null;
}

function FileHeader({ name, role, children }: { name: string; role: Scope["role"]; children: ReactNode }) {
  return <header className="flex flex-wrap items-start gap-3">
    <div className="min-w-0" style={{ flex: "1 1 15rem" }}>
      <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>Shared file</p>
      <h1 className="mt-1 break-words text-2xl font-semibold">{name}</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{ROLE_LABEL[role]}</p>
    </div>
    <div className="flex flex-wrap gap-2">{children}</div>
  </header>;
}

function DraftEditor({ draft, onChange, saving, tooLarge, inConflict }: {
  draft: string;
  onChange: (value: string) => void;
  saving: boolean;
  tooLarge: boolean;
  inConflict: boolean;
}) {
  return <>
    {inConflict ? <p className="text-sm font-medium">Your version</p> : null}
    {tooLarge ? <p className="text-sm">This text is over the 64 KB limit for editing here. Shorten it to save.</p> : null}
    {/* Read-only while saving: the request carries this exact text, so nothing typed meanwhile can be dropped. */}
    <textarea aria-label="File contents" value={draft} readOnly={saving} onChange={(event) => onChange(event.target.value)} spellCheck={false}
      className="w-full rounded-2xl border bg-transparent p-4 font-mono text-sm" style={{ minHeight: inConflict ? "30vh" : "50vh" }} />
  </>;
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
