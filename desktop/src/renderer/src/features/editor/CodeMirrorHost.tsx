import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { getThemeEditorColors } from "../../design/themes";
import { resolveThemeMode } from "../../design/themes/apply";
import { toUserMessage } from "../../lib/errors";
import { useAppearance } from "../../stores/appearance";
import { useConnection } from "../../stores/connection";
import { buildEditorTheme } from "./editor-theme";
import { ConflictBar } from "./EditorPanel";
import { useEditorTabs } from "./editor-tabs-store";
import { createFilesApi, openFile, saveFile, saveFileOverwrite, type OpenedFile } from "./editor-save";

const MAX_DOCUMENT_CACHE_ENTRIES = 64;

type CachedDocument = {
  file: OpenedFile;
  content: string;
};

const documentCache = new Map<string, CachedDocument>();

function cacheKey(taskId: string, path: string): string {
  return `${taskId}\0${path}`;
}

function getCachedDocument(key: string): CachedDocument | null {
  const cached = documentCache.get(key);
  if (!cached) return null;
  documentCache.delete(key);
  documentCache.set(key, cached);
  return cached;
}

function setCachedDocument(key: string, cached: CachedDocument): void {
  if (documentCache.has(key)) documentCache.delete(key);
  documentCache.set(key, cached);
  while (documentCache.size > MAX_DOCUMENT_CACHE_ENTRIES) {
    const oldest = documentCache.keys().next().value;
    if (typeof oldest !== "string") break;
    documentCache.delete(oldest);
  }
}

function languageExtension(filename: string) {
  const ext = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase()}` : "";
  switch (ext) {
    case ".js":
    case ".jsx":
      return javascript({ jsx: true });
    case ".ts":
    case ".tsx":
      return javascript({ jsx: true, typescript: true });
    case ".json":
      return json();
    case ".md":
    case ".mdx":
      return markdown();
    case ".html":
      return html();
    case ".css":
    case ".scss":
      return css();
    case ".py":
      return python();
    default:
      return [];
  }
}

export default function CodeMirrorHost({ taskId, path }: { taskId: string; path: string }) {
  const api = useConnection((s) => s.api);
  const setDirty = useEditorTabs((s) => s.setDirty);
  // Recreate the editor when the unified theme changes; the document cache
  // preserves unsaved content across the remount.
  const themeId = useAppearance((s) => s.themeId);
  const themeMode = useAppearance((s) => s.mode);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileRef = useRef<OpenedFile | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const doSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    if (!api || !hostRef.current) return;
    const files = createFilesApi(api);
    const host = hostRef.current;
    const key = cacheKey(taskId, path);
    let disposed = false;
    const resolvedThemeMode = resolveThemeMode(themeMode);
    const editorThemeExtensions = buildEditorTheme(
      getThemeEditorColors(themeId, resolvedThemeMode),
      resolvedThemeMode === "dark",
    );

    void openFile(files, path)
      .then((file) => {
        if (disposed) return;
        const cached = getCachedDocument(key);
        const dirtyCached = cached && cached.content !== cached.file.content ? cached : null;
        const initialContent = dirtyCached?.content ?? file.content;
        fileRef.current = dirtyCached?.file ?? file;
        setCachedDocument(key, { file: fileRef.current, content: initialContent });
        setDirty(taskId, path, initialContent !== fileRef.current.content);
        const state = EditorState.create({
          doc: initialContent,
          extensions: [
            lineNumbers(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            languageExtension(path),
            ...editorThemeExtensions,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                const content = update.state.doc.toString();
                if (fileRef.current) {
                  setCachedDocument(key, { file: fileRef.current, content });
                }
                setDirty(taskId, path, content !== fileRef.current?.content);
              }
            }),
            EditorView.theme({
              "&": { height: "100%", fontSize: "13px" },
              ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
            }),
          ],
        });
        viewRef.current = new EditorView({ state, parent: host });
      })
      .catch((err: unknown) => {
        if (!disposed) setLoadError(toUserMessage(err));
      });

    return () => {
      disposed = true;
      if (viewRef.current && fileRef.current) {
        setCachedDocument(key, { file: fileRef.current, content: viewRef.current.state.doc.toString() });
      }
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [api, path, setDirty, taskId, themeId, themeMode]);

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
    const view = viewRef.current;
    const file = fileRef.current;
    if (!api || !view || !file || saveInFlightRef.current) return;
    const content = view.state.doc.toString();
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const result = await saveFile(createFilesApi(api), file, content);
      if (result.ok) {
        fileRef.current = { ...file, content, loadedMtime: result.newMtime };
        setCachedDocument(cacheKey(taskId, path), { file: fileRef.current, content });
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
    const view = viewRef.current;
    if (!api || !view || saveInFlightRef.current) return;
    const content = view.state.doc.toString();
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const newMtime = await saveFileOverwrite(createFilesApi(api), path, content);
      fileRef.current = { path, content, loadedMtime: newMtime };
      setCachedDocument(cacheKey(taskId, path), { file: fileRef.current, content });
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
    const view = viewRef.current;
    if (!api || !view || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const file = await openFile(createFilesApi(api), path);
      fileRef.current = file;
      setCachedDocument(cacheKey(taskId, path), { file, content: file.content });
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
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
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{loadError}</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" data-selectable />
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
