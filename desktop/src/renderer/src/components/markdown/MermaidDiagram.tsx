import { useEffect, useState } from "react";
import { MAX_DIAGRAM_LENGTH, renderMermaid } from "./render-mermaid";

type DiagramState = { url?: string; error?: string };

export function MermaidDiagram({ source, copyText = (value) => navigator.clipboard.writeText(value) }: {
  source: string;
  copyText?: (text: string) => Promise<unknown> | unknown;
}) {
  return <DiagramContent key={source} source={source} copyText={copyText} />;
}

function DiagramContent({ source, copyText }: { source: string; copyText: (text: string) => Promise<unknown> | unknown }) {
  const [state, setState] = useState<DiagramState>({});
  const [showSource, setShowSource] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const tooLarge = source.length > MAX_DIAGRAM_LENGTH;
  const error = tooLarge ? "Diagram is too large to render. View the source below." : state.error;
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    if (tooLarge) return;
    // Streaming fences can be syntactically incomplete; coalesce rapid updates.
    const timer = window.setTimeout(() => {
      void renderMermaid(source).then((svg) => {
        if (!active) return;
        // SVG images cannot execute scripts, load external resources, or invoke
        // renderer/preload APIs. Never insert diagram HTML into the chat DOM.
        objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setState({ url: objectUrl });
      }).catch((error: unknown) => {
        console.warn("[diagram] render failed", error instanceof Error ? error.name : "UnknownError");
        if (active) setState({ error: "Diagram unavailable. View the source below." });
      });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, tooLarge]);

  async function copy() {
    try {
      await copyText(source);
      setCopyState("copied");
    } catch (error: unknown) {
      console.warn("[diagram] copy failed", error instanceof Error ? error.name : "UnknownError");
      setCopyState("failed");
    }
  }

  return <div className="my-3 min-w-0 overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
    <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
      <span>Mermaid</span>
      <span className="flex gap-3">
        <button type="button" aria-label={showSource ? "Show diagram" : "Show diagram source"} aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}>{showSource ? "Diagram" : "Source"}</button>
        <button type="button" aria-label="Copy diagram source" onClick={() => void copy()}>{copyState === "copied" ? "Copied" : "Copy"}</button>
      </span>
    </div>
    {copyState === "failed" ? <p role="status" className="px-3 text-xs">Could not copy diagram. Try again.</p> : null}
    {error ? <p role="status" className="px-3 text-xs">{error}</p> : null}
    {showSource || error ? <pre className="max-h-96 overflow-auto p-3 text-xs"><code>{source}</code></pre>
      : state.url ? <div className="overflow-auto bg-white p-4"><img src={state.url} alt="Mermaid diagram" className="mx-auto h-auto max-h-[640px] max-w-full" /></div>
        : <p role="status" className="p-3 text-xs">Rendering diagram…</p>}
  </div>;
}
