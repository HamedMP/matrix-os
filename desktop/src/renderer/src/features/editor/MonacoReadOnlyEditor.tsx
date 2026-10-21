import { getThemeVariant, MONO_FONT_OPTIONS } from "@matrix-os/brand/themes";
import { monacoTheme } from "@matrix-os/brand/themes/editor";
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
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const appearanceMode = useAppearance((state) => state.resolvedMode);
  const appearanceThemeId = useAppearance((state) => state.themeId);
  const customTheme = useAppearance((state) => state.customTheme);
  const monoFontId = useAppearance((state) => state.monoFontId);
  const appearanceRef = useRef({ appearanceMode, appearanceThemeId, customTheme, monoFontId });
  useEffect(() => {
    appearanceRef.current = { appearanceMode, appearanceThemeId, customTheme, monoFontId };
  }, [appearanceMode, appearanceThemeId, customTheme, monoFontId]);
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
      const { appearanceMode, appearanceThemeId, customTheme, monoFontId } = appearanceRef.current;
      monaco.editor.defineTheme("matrix-appearance", monacoTheme(getThemeVariant(appearanceThemeId, appearanceMode, customTheme), appearanceMode === "dark"));
      editor = monaco.editor.create(host, {
        value: content,
        language: languageForPath(path),
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: MONO_FONT_OPTIONS.find(font => font.id === monoFontId)?.family ?? MONO_FONT_OPTIONS[0].family,
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
        theme: "matrix-appearance",
        ariaLabel: `Preview ${path}`,
      });
      editorRef.current = editor;
    }).catch((error: unknown) => {
      if (current) console.warn("[desktop-preview] Monaco initialization failed:", error instanceof Error ? error.name : typeof error);
    });
    return () => {
      current = false;
      editor?.dispose();
      editorRef.current = null;
    };
  }, [content, path, supportsMonaco]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let current = true;
    editor.updateOptions({ fontFamily: MONO_FONT_OPTIONS.find(font => font.id === monoFontId)?.family ?? MONO_FONT_OPTIONS[0].family });
    void import("monaco-editor").then((monaco) => {
      if (!current || editorRef.current !== editor) return;
      monaco.editor.defineTheme("matrix-appearance", monacoTheme(getThemeVariant(appearanceThemeId, appearanceMode, customTheme), appearanceMode === "dark"));
      monaco.editor.setTheme("matrix-appearance");
    }).catch((error: unknown) => {
      if (current) console.warn("[desktop-preview] Theme update failed:", error instanceof Error ? error.name : typeof error);
    });
    return () => { current = false; };
  }, [appearanceMode, appearanceThemeId, customTheme, monoFontId]);

  if (!supportsMonaco) {
    return <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs" data-monaco-fallback>{content}</pre>;
  }
  return <div ref={hostRef} className="min-h-0 flex-1" data-monaco-editor data-path={path} />;
}
