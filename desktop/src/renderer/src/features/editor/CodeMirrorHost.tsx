import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { ConflictBar } from "./EditorPanel";
import { useEditorTabs } from "./editor-tabs-store";
import { createFilesApi, openFile, saveFile, saveFileOverwrite, type OpenedFile } from "./editor-save";

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

export default function CodeMirrorHost({ path }: { taskId: string; path: string }) {
  const api = useConnection((s) => s.api);
  const setDirty = useEditorTabs((s) => s.setDirty);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileRef = useRef<OpenedFile | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!api || !hostRef.current) return;
    const files = createFilesApi(api);
    const host = hostRef.current;
    let disposed = false;

    void openFile(files, path)
      .then((file) => {
        if (disposed) return;
        fileRef.current = file;
        const state = EditorState.create({
          doc: file.content,
          extensions: [
            lineNumbers(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            languageExtension(path),
            oneDark,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                setDirty(path, update.state.doc.toString() !== fileRef.current?.content);
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
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [api, path, setDirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function doSave(): Promise<void> {
    const view = viewRef.current;
    const file = fileRef.current;
    if (!api || !view || !file || saving) return;
    const content = view.state.doc.toString();
    setSaving(true);
    try {
      const result = await saveFile(createFilesApi(api), file, content);
      if (result.ok) {
        fileRef.current = { ...file, content, loadedMtime: result.newMtime };
        setDirty(path, false);
        setConflict(false);
      } else {
        setConflict(true);
      }
    } catch (err: unknown) {
      console.warn("[editor] save failed:", err instanceof Error ? err.message : String(err));
      setLoadError(toUserMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function overwrite(): Promise<void> {
    const view = viewRef.current;
    if (!api || !view) return;
    const content = view.state.doc.toString();
    try {
      const newMtime = await saveFileOverwrite(createFilesApi(api), path, content);
      fileRef.current = { path, content, loadedMtime: newMtime };
      setDirty(path, false);
      setConflict(false);
    } catch (err: unknown) {
      console.warn("[editor] overwrite failed:", err instanceof Error ? err.message : String(err));
      setLoadError(toUserMessage(err));
    }
  }

  async function reload(): Promise<void> {
    const view = viewRef.current;
    if (!api || !view) return;
    try {
      const file = await openFile(createFilesApi(api), path);
      fileRef.current = file;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
      setDirty(path, false);
      setConflict(false);
    } catch (err: unknown) {
      setLoadError(toUserMessage(err));
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
      {conflict ? <ConflictBar onOverwrite={() => void overwrite()} onReload={() => void reload()} /> : null}
    </div>
  );
}
