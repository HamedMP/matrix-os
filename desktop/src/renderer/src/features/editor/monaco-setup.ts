// Monaco bundled locally via vite workers (no CDN; CSP forbids remote code).
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

monaco.editor.defineTheme("operator-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#14141b",
    "editor.foreground": "#e9e9f1",
    "editorLineNumber.foreground": "#4a4a5c",
    "editorLineNumber.activeForeground": "#a3a3b8",
    "editor.selectionBackground": "#7c6ff74d",
    "editorCursor.foreground": "#7c6ff7",
    "editorWidget.background": "#1f1f2a",
    "editorWidget.border": "#2c2c3a",
  },
});

export { monaco };

// Model cache so open files survive panel/workspace remounts (SC-006).
const models = new Map<string, monaco.editor.ITextModel>();
const MODEL_CACHE_CAP = 32;

export function getOrCreateModel(path: string, content: string): monaco.editor.ITextModel {
  const existing = models.get(path);
  if (existing && !existing.isDisposed()) {
    models.delete(path);
    models.set(path, existing);
    if (existing.getValue() !== content) existing.setValue(content);
    return existing;
  }
  if (models.size >= MODEL_CACHE_CAP) {
    const oldest = models.keys().next().value as string | undefined;
    if (oldest) {
      models.get(oldest)?.dispose();
      models.delete(oldest);
    }
  }
  const model = monaco.editor.createModel(content, undefined, monaco.Uri.file(path));
  models.set(path, model);
  return model;
}

export function dropModel(path: string): void {
  const model = models.get(path);
  if (model) {
    model.dispose();
    models.delete(path);
  }
}
