import { useEffect, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { useAppearance } from "../../stores/appearance";

const workerScope = globalThis as typeof globalThis & {
  MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
};

workerScope.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
    return new EditorWorker();
  },
};

export function languageForPath(path: string): string {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  const extension = name.includes(".") ? name.split(".").at(-1) : "";
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript", json: "json", jsonl: "json",
    css: "css", scss: "scss", less: "less", html: "html", htm: "html",
    md: "markdown", mdx: "markdown", py: "python", rb: "ruby", go: "go",
    rs: "rust", java: "java", kt: "kotlin", sql: "sql", sh: "shell",
    bash: "shell", zsh: "shell", yml: "yaml", yaml: "yaml", xml: "xml",
  } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

export function monacoThemeForDocument(root: HTMLElement): "vs" | "vs-dark" {
  return root.dataset.theme === "dark" ? "vs-dark" : "vs";
}

export function MonacoReadOnlyEditor({ path, content }: { path: string; content: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appearanceMode = useAppearance((state) => state.mode);
  const appearanceThemeId = useAppearance((state) => state.themeId);
  const supportsMonaco = typeof Worker === "function"
    && typeof navigator !== "undefined"
    && !navigator.userAgent.includes("jsdom");

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !supportsMonaco) return;
    let current = true;
    let editor: MonacoEditor.IStandaloneCodeEditor | null = null;
    void import("monaco-editor").then((monaco) => {
      if (!current) return;
      editor = monaco.editor.create(host, {
        value: content,
        language: languageForPath(path),
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        lineHeight: 20,
        lineNumbersMinChars: 3,
        folding: true,
        glyphMargin: false,
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        wordWrap: "off",
        padding: { top: 12, bottom: 12 },
        theme: monacoThemeForDocument(document.documentElement),
        ariaLabel: `Preview ${path}`,
      });
    });
    return () => {
      current = false;
      editor?.dispose();
    };
  }, [appearanceMode, appearanceThemeId, content, path, supportsMonaco]);

  if (!supportsMonaco) {
    return <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs" data-monaco-fallback>{content}</pre>;
  }
  return <div ref={hostRef} className="min-h-0 flex-1" data-monaco-editor data-path={path} />;
}
