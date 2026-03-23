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
  }, [filename]); // Re-create editor when filename changes

  // Update content when prop changes (external reload)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== content) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
    }
  }, [content]);

  return <div ref={containerRef} className="h-full" />;
}
