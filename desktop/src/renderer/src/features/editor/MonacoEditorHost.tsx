import { useEffect, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { Button } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useAppearance } from "../../stores/appearance";
import { useConnection } from "../../stores/connection";
import { ConflictBar } from "./EditorPanel";
import { languageForPath, monacoThemeForDocument } from "./MonacoReadOnlyEditor";
import {
  createFilesApi,
  openFile,
  saveFile,
  saveFileOverwrite,
  type FilesApi,
  type OpenedFile,
} from "./editor-save";

export const MAX_MONACO_FILE_BYTES = 2 * 1024 * 1024;

class EditorScopeChangedError extends Error {
  constructor() {
    super("editor_scope_changed");
  }
}

function scopeKey(): string {
  const { runtimeSlot, authGeneration } = useConnection.getState();
  return `${runtimeSlot}|${authGeneration}`;
}

function scopedFilesApi(files: FilesApi, scope: string): FilesApi {
  const guard = async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (scopeKey() !== scope) throw new EditorScopeChangedError();
    const result = await operation();
    if (scopeKey() !== scope) throw new EditorScopeChangedError();
    return result;
  };
  return {
    stat: (path) => guard(() => files.stat(path)),
    read: (path) => guard(() => files.read(path)),
    write: (path, content) => guard(() => files.write(path, content)),
  };
}

function exceedsEditorLimit(content: string): boolean {
  return new TextEncoder().encode(content).byteLength > MAX_MONACO_FILE_BYTES;
}

export default function MonacoEditorHost({
  path,
  active,
  onDirtyChange,
}: {
  path: string;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const appearanceMode = useAppearance((state) => state.mode);
  const appearanceThemeId = useAppearance((state) => state.themeId);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef<OpenedFile | null>(null);
  const filesRef = useRef<FilesApi | null>(null);
  const contentRef = useRef("");
  const saveInFlightRef = useRef(false);
  const saveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const dirtyChangeRef = useRef(onDirtyChange);
  dirtyChangeRef.current = onDirtyChange;
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [fallbackContent, setFallbackContent] = useState("");
  const [monacoState, setMonacoState] = useState<"pending" | "ready" | "failed">("pending");
  const supportsMonaco = typeof Worker === "function"
    && typeof navigator !== "undefined"
    && !navigator.userAgent.includes("jsdom");

  useEffect(() => {
    if (!api) return;
    const scope = `${runtimeSlot}|${authGeneration}`;
    const files = scopedFilesApi(createFilesApi(api, MAX_MONACO_FILE_BYTES), scope);
    let disposed = false;
    setLoadState("loading");
    setLoadError(null);
    setSaveError(null);
    setConflict(false);
    setMonacoState("pending");
    fileRef.current = null;
    filesRef.current = files;
    contentRef.current = "";
    void openFile(files, path).then((file) => {
      if (disposed || scopeKey() !== scope) return;
      fileRef.current = file;
      contentRef.current = file.content;
      setFallbackContent(file.content);
      dirtyChangeRef.current(false);
      setLoadState("ready");
      setDocumentRevision((revision) => revision + 1);
    }).catch((error: unknown) => {
      if (disposed || error instanceof EditorScopeChangedError) return;
      setLoadError(error instanceof Error && error.message === "file_too_large"
        ? "This file is larger than the 2 MB editor limit."
        : toUserMessage(error));
      setLoadState("error");
    });
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [api, authGeneration, path, runtimeSlot]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !supportsMonaco || loadState !== "ready") return;
    let current = true;
    let model: MonacoEditor.ITextModel | null = null;
    setMonacoState("pending");
    void import("monaco-editor").then((monaco) => {
      if (!current) return;
      model = monaco.editor.createModel(contentRef.current, languageForPath(path));
      const editor = monaco.editor.create(host, {
        model,
        automaticLayout: true,
        minimap: { enabled: true, maxColumn: 80 },
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        lineHeight: 20,
        lineNumbersMinChars: 3,
        folding: true,
        glyphMargin: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        wordWrap: "off",
        padding: { top: 10, bottom: 10 },
        theme: monacoThemeForDocument(document.documentElement),
        ariaLabel: `Edit ${path}`,
      });
      editor.onDidChangeModelContent(() => {
        contentRef.current = editor.getValue();
        dirtyChangeRef.current(contentRef.current !== fileRef.current?.content);
      });
      editorRef.current = editor;
      setMonacoState("ready");
    }).catch((error: unknown) => {
      model?.dispose();
      model = null;
      if (!current) return;
      console.warn(
        "[desktop-editor] Monaco initialization failed:",
        error instanceof Error ? error.name : typeof error,
      );
      setMonacoState("failed");
    });
    return () => {
      current = false;
      editorRef.current?.dispose();
      editorRef.current = null;
      model?.dispose();
    };
  }, [appearanceMode, appearanceThemeId, documentRevision, loadState, path, supportsMonaco]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  async function save(): Promise<void> {
    const file = fileRef.current;
    const files = filesRef.current;
    const content = contentRef.current;
    if (!file || !files || saveInFlightRef.current) return;
    if (exceedsEditorLimit(content)) {
      setSaveError("This document exceeds the 2 MB editor limit and was not saved.");
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const result = await saveFile(files, file, content);
      if (result.ok) {
        fileRef.current = { ...file, content, loadedMtime: result.newMtime };
        dirtyChangeRef.current(false);
        setConflict(false);
        setSaveError(null);
      } else {
        setConflict(true);
        setSaveError(null);
      }
    } catch (error: unknown) {
      if (!(error instanceof EditorScopeChangedError)) setSaveError(toUserMessage(error));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }
  saveRef.current = save;

  async function overwrite(): Promise<void> {
    const files = filesRef.current;
    const content = contentRef.current;
    if (!files || saveInFlightRef.current || exceedsEditorLimit(content)) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const loadedMtime = await saveFileOverwrite(files, path, content);
      fileRef.current = { path, content, loadedMtime };
      dirtyChangeRef.current(false);
      setConflict(false);
      setSaveError(null);
    } catch (error: unknown) {
      if (!(error instanceof EditorScopeChangedError)) setSaveError(toUserMessage(error));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function reload(): Promise<void> {
    const files = filesRef.current;
    if (!files || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const file = await openFile(files, path);
      fileRef.current = file;
      contentRef.current = file.content;
      setFallbackContent(file.content);
      editorRef.current?.setValue(file.content);
      dirtyChangeRef.current(false);
      setConflict(false);
      setSaveError(null);
    } catch (error: unknown) {
      if (!(error instanceof EditorScopeChangedError)) setSaveError(toUserMessage(error));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  if (loadState === "loading") {
    return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>Opening {path}…</div>;
  }
  if (loadState === "error") {
    return <div role="alert" className="flex flex-1 items-center justify-center px-6 text-center text-sm" style={{ color: "var(--danger)" }}>{loadError}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {supportsMonaco ? (
          <div
            ref={hostRef}
            className="absolute inset-0 min-h-0"
            data-monaco-editor
            data-monaco-state={monacoState}
            data-path={path}
            style={monacoState === "ready" ? undefined : { opacity: 0, pointerEvents: "none" }}
          />
        ) : null}
        <textarea
          aria-label={`Edit ${path}`}
          value={fallbackContent}
          hidden={supportsMonaco && monacoState === "ready"}
          onChange={(event) => {
            const content = event.target.value;
            contentRef.current = content;
            setFallbackContent(content);
            dirtyChangeRef.current(content !== fileRef.current?.content);
          }}
          className="absolute inset-0 size-full resize-none border-0 p-4 font-mono text-[13px] leading-5 outline-none"
          style={{ background: "var(--bg-sunken)", color: "var(--text-primary)" }}
        />
      </div>
      {saveError ? (
        <div role="alert" className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
          <span>{saveError}</span><Button variant="ghost" onClick={() => setSaveError(null)}>Dismiss</Button>
        </div>
      ) : null}
      {conflict ? <ConflictBar busy={saving} onReload={() => void reload()} onOverwrite={() => void overwrite()} /> : null}
    </div>
  );
}
