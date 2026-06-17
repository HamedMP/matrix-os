import { useEffect, useRef, useState } from "react";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { ConflictBar } from "./EditorPanel";
import { useEditorTabs } from "./editor-tabs-store";
import { createFilesApi, openFile, saveFile, saveFileOverwrite, type OpenedFile } from "./editor-save";
import { getFileBaseline, rememberFileBaseline } from "./editor-baselines";
import { getOrCreateModel, markModelBaseline, monaco } from "./monaco-setup";

function fileBaselineKey(taskId: string, path: string): string {
  return `${taskId}\u0000${path}`;
}

export default function MonacoHost({ taskId, path }: { taskId: string; path: string }) {
  const api = useConnection((s) => s.api);
  const setDirty = useEditorTabs((s) => s.setDirty);
  const hostRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<OpenedFile | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const doSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    if (!api || !hostRef.current) return;
    const files = createFilesApi(api);
    let disposed = false;
    const host = hostRef.current;
    let contentSubscription: { dispose(): void } | null = null;

    const editor = monaco.editor.create(host, {
      theme: "operator-dark",
      fontSize: 13,
      fontFamily: 'JetBrains Mono, "SF Mono", Menlo, monospace',
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      padding: { top: 8 },
    });
    editorRef.current = editor;

    void openFile(files, path)
      .then((file) => {
        if (disposed) return;
        const baselineKey = fileBaselineKey(taskId, path);
        const model = getOrCreateModel(taskId, path, file.content);
        const hasUnsavedModel = model.getValue() !== file.content;
        const previousBaseline = getFileBaseline(baselineKey);
        const baseline = hasUnsavedModel ? (previousBaseline ?? { ...file, loadedMtime: null }) : file;
        fileRef.current = baseline;
        if (!hasUnsavedModel) {
          rememberFileBaseline(baselineKey, file);
          setConflict(false);
        } else if (previousBaseline && previousBaseline.loadedMtime !== file.loadedMtime) {
          setConflict(true);
          setSaveError(null);
        }
        editor.setModel(model);
        setDirty(taskId, path, model.getValue() !== baseline.content);
        contentSubscription = model.onDidChangeContent(() => {
          setDirty(taskId, path, model.getValue() !== fileRef.current?.content);
        });
      })
      .catch((err: unknown) => {
        if (!disposed) setLoadError(toUserMessage(err));
      });

    return () => {
      disposed = true;
      contentSubscription?.dispose();
      contentSubscription = null;
      editorRef.current = null;
      editor.dispose();
    };
  }, [api, path, setDirty, taskId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSaveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function doSave(): Promise<void> {
    const editor = editorRef.current;
    const file = fileRef.current;
    if (!api || !editor || !file || saveInFlightRef.current) return;
    const content = editor.getValue();
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const result = await saveFile(createFilesApi(api), file, content);
      if (result.ok) {
        const saved = { ...file, content, loadedMtime: result.newMtime };
        fileRef.current = saved;
        rememberFileBaseline(fileBaselineKey(taskId, path), saved);
        markModelBaseline(taskId, path, content);
        setDirty(taskId, path, false);
        setConflict(false);
        setSaveError(null);
      } else {
        setConflict(true);
        setSaveError(null);
      }
    } catch (err: unknown) {
      console.warn("[editor] save failed:", err instanceof Error ? err.message : String(err));
      setSaveError(toUserMessage(err));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  doSaveRef.current = doSave;

  async function overwrite(): Promise<void> {
    const editor = editorRef.current;
    if (!api || !editor || saveInFlightRef.current) return;
    const content = editor.getValue();
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const newMtime = await saveFileOverwrite(createFilesApi(api), path, content);
      const overwritten = { path, content, loadedMtime: newMtime };
      fileRef.current = overwritten;
      rememberFileBaseline(fileBaselineKey(taskId, path), overwritten);
      markModelBaseline(taskId, path, content);
      setDirty(taskId, path, false);
      setConflict(false);
      setSaveError(null);
    } catch (err: unknown) {
      console.warn("[editor] overwrite failed:", err instanceof Error ? err.message : String(err));
      setSaveError(toUserMessage(err));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function reload(): Promise<void> {
    if (!api || !editorRef.current || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const file = await openFile(createFilesApi(api), path);
      fileRef.current = file;
      rememberFileBaseline(fileBaselineKey(taskId, path), file);
      editorRef.current.getModel()?.setValue(file.content);
      markModelBaseline(taskId, path, file.content);
      setDirty(taskId, path, false);
      setConflict(false);
      setSaveError(null);
    } catch (err: unknown) {
      console.warn("[editor] reload failed:", err instanceof Error ? err.message : String(err));
      setSaveError(toUserMessage(err));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {loadError}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={hostRef} className="min-h-0 flex-1" data-selectable />
      {saveError ? (
        <div
          className="border-t px-3 py-2 text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}
        >
          {saveError}
        </div>
      ) : null}
      {conflict ? (
        <ConflictBar
          busy={saving}
          onOverwrite={() => void overwrite()}
          onReload={() => void reload()}
        />
      ) : null}
    </div>
  );
}
