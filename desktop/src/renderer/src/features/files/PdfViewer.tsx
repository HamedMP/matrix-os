import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "./pdf-worker.ts?worker&url";

function logFailure(error: unknown) {
  console.warn("[pdf-preview] unavailable", error instanceof Error ? error.name : "UnknownError");
}

export default function PdfViewer({ blob, name }: { blob: Blob; name: string }) {
  const [loaded, setLoaded] = useState<{ blob: Blob; document: PDFDocumentProxy } | null>(null);
  const [failedBlob, setFailedBlob] = useState<Blob | null>(null);
  const document = loaded?.blob === blob ? loaded.document : null;
  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    const timer = window.setTimeout(() => {
      if (active) { active = false; setFailedBlob(blob); }
      void task?.destroy().catch(logFailure);
    }, 15_000);
    void Promise.all([import("pdfjs-dist"), blob.arrayBuffer()]).then(async ([pdfjs, data]) => {
      if (!active) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      task = pdfjs.getDocument({
        data: new Uint8Array(data), isEvalSupported: false, useWasm: false,
        useSystemFonts: true, disableFontFace: true,
        maxImageSize: 16_000_000, canvasMaxAreaInBytes: 64_000_000,
      });
      const document = await task.promise;
      if (active) { window.clearTimeout(timer); setLoaded({ blob, document }); }
    }).catch((error: unknown) => {
      logFailure(error);
      if (active) { window.clearTimeout(timer); setFailedBlob(blob); }
    });
    return () => {
      active = false; window.clearTimeout(timer);
      void task?.destroy().catch(logFailure);
    };
  }, [blob]);

  if (failedBlob === blob) return <PdfFailure />;
  if (!document) return <p role="status" className="p-4 text-sm">Loading PDF…</p>;
  return <PdfPages document={document} name={name} />;
}

function PdfFailure() {
  return <p role="alert" className="p-4 text-sm">PDF preview unavailable. Download the file to open it.</p>;
}

function PdfPages({ document, name }: { document: PDFDocumentProxy; name: string }) {
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let active = true;
    let renderTask: RenderTask | undefined;
    const canvas = canvasRef.current;
    void document.getPage(page).then(async (pdfPage) => {
      if (!active) return;
      const natural = pdfPage.getViewport({ scale: zoom });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(natural.width, natural.height));
      const viewport = pdfPage.getViewport({ scale: zoom * outputScale });
      const context = canvas.getContext("2d");
      if (!context) throw new Error("CanvasUnavailable");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${natural.width}px`; canvas.style.height = `${natural.height}px`;
      renderTask = pdfPage.render({ canvasContext: context, canvas, viewport });
      await renderTask.promise;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "RenderingCancelledException") return;
      logFailure(error);
      if (active) setFailed(true);
    });
    return () => { active = false; renderTask?.cancel(); };
  }, [document, page, zoom]);

  if (failed) return <PdfFailure />;
  return <div className="flex min-h-96 min-w-0 w-full flex-1 flex-col" aria-label={`PDF preview: ${name}`}>
    <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
      <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
      <input aria-label="Page number" type="number" min={1} max={document.numPages} value={page} className="w-12 rounded border bg-transparent p-1" onChange={(event) => {
        const value = event.currentTarget.valueAsNumber;
        if (Number.isInteger(value) && value >= 1 && value <= document.numPages) setPage(value);
      }} />
      <span>of {document.numPages}</span>
      <button type="button" aria-label="Next page" disabled={page >= document.numPages} onClick={() => setPage((value) => value + 1)}>Next</button>
      <button type="button" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))}>+</button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3"><canvas ref={canvasRef} aria-label={`Page ${page} of ${name}`} className="mx-auto bg-white shadow" /></div>
  </div>;
}
