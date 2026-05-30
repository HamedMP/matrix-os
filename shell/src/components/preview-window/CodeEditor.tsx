"use client";

import { useEffect, useRef, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";

function getLanguageExtension(filename: string) {
  const ext = filename.includes(".")
    ? `.${filename.split(".").pop()!.toLowerCase()}`
    : "";
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
      return markdown();
    case ".html":
      return html();
    case ".css":
      return css();
    case ".py":
      return python();
    default:
      return [];
  }
}

interface CodeEditorProps {
  content: string;
  filename: string;
  onChange?: (value: string) => void;
}

export function CodeEditor({ content, filename, onChange }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const onChangeRef = useRef(onChange);
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value ref sync so the CodeMirror updateListener (registered once per filename in the effect below) always calls the freshest onChange without tearing down and recreating the editor on every render.
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        getLanguageExtension(filename),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- `content` is intentionally omitted: it only seeds the editor's initial `doc` on (re)creation. Ongoing external content changes are applied in-place by the separate effect below; adding `content` here would destroy and rebuild the editor on every keystroke, dropping cursor/scroll/undo state.
  }, [filename]); // Re-create editor when filename changes

  // Update content when prop changes (external reload)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    // react-doctor-disable-next-line react-doctor/no-event-handler -- syncs the imperative CodeMirror view with an external prop change (file reloaded from disk), not a side effect derivable from a local UI event; there is no triggering event handler to move this into.
    if (currentDoc !== content) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
    }
  }, [content]);

  return <div ref={containerRef} className="h-full" />;
}
