import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

/** The scoped runtime writer accepts complete UTF-8 worktree files up to 64 KiB. */
export function ProjectPreviewEditor({ projectId, worktreeId, path, saveRequest, onDirtyChange }: {
  projectId: string;
  worktreeId: string;
  path: string;
  saveRequest: number;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const initialScope = useRef({ runtimeSlot, authGeneration });
  const onDirtyRef = useRef(onDirtyChange);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onDirtyRef.current = onDirtyChange; }, [onDirtyChange]);
  const handledSaveRequest = useRef(0);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; original: string; content: string; etag: string; error?: string; saving?: boolean }>(
    { status: "loading", original: "", content: "", etag: "" },
  );
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const current = useCallback(() => {
    const connection = useConnection.getState();
    return mounted.current && connection.runtimeSlot === initialScope.current.runtimeSlot
      && connection.authGeneration === initialScope.current.authGeneration;
  }, []);
  const reload = useCallback(async () => {
    if (!current()) return;
    setState((previous) => ({ ...previous, status: "loading", error: undefined }));
    try {
      const file = await invoke("runtime:get-file-content", { projectId, worktreeId, path });
      if (!current()) return;
      if (file.truncated) throw new Error("File exceeds the worktree editor limit.");
      setState({ status: "ready", original: file.content, content: file.content, etag: file.metadata.etag });
      onDirtyRef.current?.(false);
    } catch (error: unknown) {
      if (current()) setState((previous) => ({ ...previous, status: "error", error: error instanceof Error && error.message === "File exceeds the worktree editor limit." ? error.message : "File unavailable. Check its path and permissions." }));
    }
  }, [current, path, projectId, worktreeId]);
  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const state = stateRef.current;
    if (!current() || saveRequest === 0 || saveRequest === handledSaveRequest.current || state.status !== "ready" || state.saving || state.content === state.original) return;
    handledSaveRequest.current = saveRequest;
    if (new TextEncoder().encode(state.content).byteLength > 65_536) {
      setState((previous) => ({ ...previous, error: "This file exceeds the 64 KiB worktree editor limit." }));
      return;
    }
    const snapshot = state;
    setState((previous) => ({ ...previous, saving: true, error: undefined }));
    void invoke("runtime:save-file-content", {
      projectId, worktreeId, path, content: snapshot.content, encoding: "utf8",
      baseEtag: snapshot.etag, clientRequestId: crypto.randomUUID(),
    }).then((result) => {
      if (!current()) return;
      setState((previous) => ({ ...previous, saving: false, original: snapshot.content, etag: result.metadata.etag,
        error: previous.content === snapshot.content ? undefined : "Saved earlier changes. Save again to include your latest edits." }));
      onDirtyRef.current?.(false);
    }).catch((error: unknown) => {
      if (!current()) return;
      console.warn("[project-preview] save failed", error instanceof Error ? error.name : "UnknownError");
      setState((previous) => ({ ...previous, saving: false, error: "Could not save. The file may have changed; reload it before retrying." }));
    });
  }, [current, path, projectId, saveRequest, worktreeId]);

  if (state.status === "loading") return <p role="status" className="p-4 text-xs">Opening file…</p>;
  if (state.status === "error") return <p role="alert" className="p-4 text-xs">{state.error}</p>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <textarea aria-label={`Edit ${path}`} value={state.content} disabled={state.saving} onChange={(event) => {
      const content = event.target.value;
      setState((previous) => ({ ...previous, content }));
      onDirtyRef.current?.(content !== state.original);
    }} className="min-h-0 flex-1 resize-none bg-[var(--bg-sunken)] p-4 font-mono text-[13px] leading-5 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" />
    {state.error ? <div role="alert" className="flex items-center gap-3 border-t p-2 text-xs text-[var(--danger)]">
      <span>{state.error}</span><button type="button" onClick={() => { if (state.content === state.original || window.confirm("Discard unsaved changes to this file?")) void reload(); }} className="underline">Reload</button>
    </div> : null}
    {state.saving ? <p role="status" className="p-2 text-xs">Saving…</p> : null}
  </div>;
}
