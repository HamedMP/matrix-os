import { useEffect, useRef, useState } from "react";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { ConflictBar } from "./EditorPanel";
import { useEditorTabs } from "./editor-tabs-store";
import { createFilesApi, openFile, saveFile, saveFileOverwrite, type OpenedFile } from "./editor-save";
import { getOrCreateModel, monaco } from "./monaco-setup";

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
  const doSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    if (!api || !hostRef.current) return;
    const files = createFilesApi(api);
    let disposed = false;
    const host = hostRef.current;

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
        fileRef.current = file;
        const model = getOrCreateModel(path, file.content);
        editor.setModel(model);
        setDirty(taskId, path, model.getValue() !== file.content);
        const contentSubscription = model.onDidChangeContent(() => {
          setDirty(taskId, path, model.getValue() !== fileRef.current?.content);
        });
        editor.onDidDispose(() => contentSubscription.dispose());
      })
      .catch((err: unknown) => {
        if (!disposed) setLoadError(toUserMessage(err));
      });

    return () => {
      disposed = true;
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
    if (!api || !editor || !file || saving) return;
    const content = editor.getValue();
    setSaving(true);
    try {
      const result = await saveFile(createFilesApi(api), file, content);
      if (result.ok) {
        fileRef.current = { ...file, content, loadedMtime: result.newMtime };
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
      setSaving(false);
    }
  }

  doSaveRef.current = doSave;

  async function overwrite(): Promise<void> {
    const editor = editorRef.current;
    if (!api || !editor) return;
    const content = editor.getValue();
    try {
      const newMtime = await saveFileOverwrite(createFilesApi(api), path, content);
      fileRef.current = { path, content, loadedMtime: newMtime };
      setDirty(taskId, path, false);
      setConflict(false);
      setSaveError(null);
    } catch (err: unknown) {
      console.warn("[editor] overwrite failed:", err instanceof Error ? err.message : String(err));
      setSaveError(toUserMessage(err));
    }
  }

  async function reload(): Promise<void> {
    if (!api || !editorRef.current) return;
    try {
      const file = await openFile(createFilesApi(api), path);
      fileRef.current = file;
      editorRef.current.getModel()?.setValue(file.content);
      setDirty(taskId, path, false);
      setConflict(false);
      setSaveError(null);
    } catch (err: unknown) {
      setLoadError(toUserMessage(err));
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
      {conflict ? <ConflictBar onOverwrite={() => void overwrite()} onReload={() => void reload()} /> : null}
    </div>
  );
}
