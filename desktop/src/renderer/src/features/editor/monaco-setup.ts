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
const modelBaselines = new Map<string, string>();
const MODEL_CACHE_CAP = 32;

function modelKey(taskId: string, path: string): string {
  return `${taskId}\u0000${path}`;
}

function modelUriPath(taskId: string, path: string): string {
  return `/.matrix-os/tasks/${encodeURIComponent(taskId)}/${path.replace(/^\/+/, "")}`;
}

function isModelClean(key: string, model: monaco.editor.ITextModel): boolean {
  const baseline = modelBaselines.get(key);
  return baseline === undefined || model.getValue() === baseline;
}

function evictOldestCleanModel(): void {
  for (const [key, model] of models) {
    if (model.isDisposed() || isModelClean(key, model)) {
      model.dispose();
      models.delete(key);
      modelBaselines.delete(key);
      return;
    }
  }
}

export function getOrCreateModel(taskId: string, path: string, content: string): monaco.editor.ITextModel {
  const key = modelKey(taskId, path);
  const existing = models.get(key);
  if (existing && !existing.isDisposed()) {
    models.delete(key);
    models.set(key, existing);
    const baseline = modelBaselines.get(key);
    if (baseline === undefined) {
      modelBaselines.set(key, existing.getValue());
    } else if (existing.getValue() === baseline) {
      if (baseline !== content) {
        existing.setValue(content);
      }
      modelBaselines.set(key, content);
    }
    return existing;
  }
  if (existing?.isDisposed()) {
    models.delete(key);
    modelBaselines.delete(key);
  }
  if (models.size >= MODEL_CACHE_CAP) {
    evictOldestCleanModel();
  }
  const model = monaco.editor.createModel(content, undefined, monaco.Uri.file(modelUriPath(taskId, path)));
  models.set(key, model);
  modelBaselines.set(key, content);
  return model;
}

export function markModelBaseline(taskId: string, path: string, content: string): void {
  const key = modelKey(taskId, path);
  if (models.has(key)) {
    modelBaselines.set(key, content);
  }
}

export function dropModel(taskId: string, path: string): void {
  const key = modelKey(taskId, path);
  const model = models.get(key);
  if (model) {
    model.dispose();
    models.delete(key);
  }
  modelBaselines.delete(key);
}
