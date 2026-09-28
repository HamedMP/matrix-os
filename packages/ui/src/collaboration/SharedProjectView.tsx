import {
  CollaborationFileListResponseSchema, CollaborationProjectSchema, CollaborationScopeSchema,
  type CollaborationCatalogEntry,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { SharedFileView } from "./SharedFileView.js";
import { SharedAppView } from "./SharedAppView.js";

type Scope = z.infer<typeof CollaborationScopeSchema>;
type Project = z.infer<typeof CollaborationProjectSchema>;
type Selection = { kind: "file"; id: string } | { kind: "app"; id: string };
const buttonClass = "rounded-xl border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function SharedProjectView({ api, scopeId, openChat, openTerminal }: {
  api: CollaborationApi;
  scopeId: string;
  openChat: (scopeId: string, chatId?: string, title?: string) => void;
  openTerminal: (scopeId: string) => void;
}) {
  const [value, setValue] = useState<{ scope: Scope; project: Project } | null>(null);
  const [files, setFiles] = useState<CollaborationCatalogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fileError, setFileError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const base = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [rawScope, rawProject] = await Promise.all([api.get(base), api.get(`${base}/project`)]);
      const scope = CollaborationScopeSchema.parse(rawScope);
      const project = CollaborationProjectSchema.parse(rawProject);
      if (scope.kind !== "project" || project.scopeId !== scope.id || project.id !== scope.resourceId) throw new Error("Project scope mismatch");
      if (current !== generation.current) return;
      setValue({ scope, project });
      setFailed(false);
      if (project.resources.some((resource) => resource.kind === "file" && resource.readiness === "ready")) {
        try {
          const page = CollaborationFileListResponseSchema.parse(await api.get(`${base}/files?limit=100`));
          if (current === generation.current) {
            setFiles(page.entries.filter((entry) => entry.kind === "file"));
            setCursor(page.nextCursor ?? null);
            setFileError(false);
          }
        } catch (error: unknown) {
          console.warn("[project-collaboration] file list failed", error instanceof Error ? error.name : "UnknownError");
          if (current === generation.current) setFileError(true);
        }
      }
    } catch (error: unknown) {
      console.warn("[project-collaboration] project load failed", error instanceof Error ? error.name : "UnknownError");
      if (current === generation.current) { setValue(null); setFailed(true); }
    }
  }, [api, base]);

  useEffect(() => {
    setValue(null);
    setFiles([]);
    setCursor(null);
    setSelection(null);
    setFailed(false);
    void load();
    return () => { generation.current += 1; };
  }, [load]);
  useEffect(() => api.subscribe?.(scopeId, load, () => {
    generation.current += 1;
    setSelection(null);
    setValue(null);
    setFailed(true);
  }), [api, load, scopeId]);

  const loadMoreFiles = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const current = generation.current;
    try {
      const page = CollaborationFileListResponseSchema.parse(await api.get(`${base}/files?limit=100&cursor=${encodeURIComponent(cursor)}`));
      if (current === generation.current) {
        setFiles((previous) => [...previous, ...page.entries.filter((entry) => entry.kind === "file" && !previous.some((old) => old.id === entry.id))]);
        setCursor(page.nextCursor ?? null);
        setFileError(false);
      }
    } catch (error: unknown) {
      console.warn("[project-collaboration] file page failed", error instanceof Error ? error.name : "UnknownError");
      if (current === generation.current) setFileError(true);
    } finally { setLoadingMore(false); }
  };

  if (failed) return <div role="alert" className="p-8">Shared project unavailable. Refresh to try again.</div>;
  if (!value) return <p role="status" className="p-8">Loading shared project…</p>;
  return <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5 p-5 sm:p-8">
    <header>
      <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>Shared project</p>
      <h1 className="mt-1 text-2xl font-semibold">{value.project.title}</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{value.scope.role === "viewer" ? "Viewer · read only" : value.scope.role === "editor" ? "Contributor · can edit" : "Owner"}</p>
    </header>
    {value.project.status === "archived" ? <p role="status" className="rounded-xl border p-4 text-sm">This project is archived.</p> : null}
    {selection ? <section>
      <button type="button" className={buttonClass} onClick={() => setSelection(null)}>Back to project</button>
      {selection.kind === "file" ? <SharedFileView key={selection.id} api={api} scopeId={scopeId} fileId={selection.id} />
        : <SharedAppView key={selection.id} api={api} scopeId={scopeId} appId={selection.id} />}
    </section> : <>
      {(["chat", "terminal", "file", "app"] as const).map((kind) => <section key={kind} aria-label={kind === "chat" ? "Chats" : kind === "terminal" ? "Terminals" : kind === "file" ? "Files" : "Apps"}>
        <h2 className="font-medium">{kind === "chat" ? "Chats" : kind === "terminal" ? "Terminals" : kind === "file" ? "Files" : "Apps"}</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">{value.project.resources.filter((resource) => resource.kind === kind).map((resource) => {
          const file = kind === "file" ? files.find((entry) => entry.path === resource.id) : undefined;
          const openable = resource.readiness === "ready" && (kind === "chat" || kind === "terminal" ? Boolean(resource.scopeId) : kind === "file" ? Boolean(file) : true);
          return <li key={`${kind}:${resource.id}`} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
            <span className="min-w-0 truncate">{resource.title}</span>
            {openable ? <button type="button" className={buttonClass} aria-label={`Open ${resource.title}`} onClick={() => {
              if (kind === "chat" && resource.scopeId) openChat(resource.scopeId, resource.id, resource.title);
              else if (kind === "terminal" && resource.scopeId) openTerminal(resource.scopeId);
              else if (kind === "file" && file) setSelection({ kind: "file", id: file.id });
              else if (kind === "app") setSelection({ kind: "app", id: resource.id });
            }}>Open</button> : <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{resource.readiness === "blocked" ? "Unavailable" : "Not available"}</span>}
          </li>;
        })}</ul>
      </section>)}
      {cursor ? <button type="button" className={buttonClass} disabled={loadingMore} onClick={() => void loadMoreFiles()}>{loadingMore ? "Loading…" : "Load more files"}</button> : null}
      {fileError ? <div role="alert" className="flex items-center gap-3 text-sm">Files could not be loaded.
        <button type="button" className={buttonClass} onClick={() => void load()}>Try again</button>
      </div> : null}
    </>}
  </main>;
}
