import { useEffect, useRef, useState, type PointerEvent } from "react";
import { pdfBoxToViewport, viewportBoxToPdf } from "../lib/pdf-render.mjs";

type Box = { x: number; y: number; width: number; height: number };
type Viewport = {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
};

export function PdfRedactionPreview({ file, page, boxes, onBox, onPageCount }: {
  file: File;
  page: number;
  boxes: Box[];
  onBox: (box: Box) => void;
  onPageCount: (count: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let pdfTask: { destroy(): Promise<void> } | null = null;
    let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
    setReady(false);
    setError("");
    viewportRef.current = null;
    void (async () => {
      try {
        if (file.size > 50 * 1024 * 1024) throw new Error("Preview supports PDF files up to 50 MB.");
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("Choose a valid PDF file.");
        const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
        pdfTask = task;
        const source = await task.promise;
        if (cancelled) return;
        onPageCount(source.numPages);
        if (!Number.isInteger(page) || page < 1 || page > source.numPages) throw new Error(`Choose a page from 1 to ${source.numPages}.`);
        const pdfPage = await source.getPage(page);
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        if (viewport.width * viewport.height > 16_000_000) throw new Error("This page is too large to preview on this device.");
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Your browser cannot preview this PDF.");
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
        await renderTask.promise;
        if (cancelled) return;
        viewportRef.current = viewport;
        setReady(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not preview this PDF.");
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      if (pdfTask) void pdfTask.destroy();
      viewportRef.current = null;
    };
  }, [file, page, onPageCount]);

  function point(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewport = viewportRef.current;
    if (!viewport || !bounds.width || !bounds.height) return null;
    return { x: Math.max(0, Math.min(viewport.width, (event.clientX - bounds.left) * viewport.width / bounds.width)), y: Math.max(0, Math.min(viewport.height, (event.clientY - bounds.top) * viewport.height / bounds.height)) };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = point(event), start = startRef.current;
    if (!current || !start) return;
    setDraft({ x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y) });
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const current = point(event), start = startRef.current, viewport = viewportRef.current;
    startRef.current = null;
    setDraft(null);
    if (!current || !start || !viewport) return;
    const drawn = { x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y) };
    if (drawn.width < 5 || drawn.height < 5) return;
    onBox(viewportBoxToPdf(viewport, drawn));
  }

  const viewport = viewportRef.current;
  const selected = viewport ? boxes.map((box) => pdfBoxToViewport(viewport, box)) : [];
  const visible = draft ? [...selected, draft] : selected;
  return <div className="mt-5 rounded-2xl border p-3 sm:p-4" style={{ borderColor: "#0E342230", background: "#F5F6EE" }}>
    <p className="mb-3 text-sm font-semibold">Draw a box over the content to remove</p>
    <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-lg border bg-white shadow-md" style={{ borderColor: "#0E34222A" }}>
      <canvas ref={canvasRef} aria-label={`Preview of PDF page ${page}`} className="block max-h-[70vh] max-w-full object-contain" />
      {ready && <div role="img" aria-label="Drag here to select a redaction rectangle" className="absolute inset-0 cursor-crosshair touch-none" onPointerDown={(event) => { const start = point(event); if (!start) return; startRef.current = start; event.currentTarget.setPointerCapture(event.pointerId); setDraft({ ...start, width: 0, height: 0 }); }} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { startRef.current = null; setDraft(null); }}>
        {visible.map((box, index) => <span key={index} className="pointer-events-none absolute border-2 border-red-600 bg-black/75" style={{ left: `${box.x / viewport!.width * 100}%`, top: `${box.y / viewport!.height * 100}%`, width: `${box.width / viewport!.width * 100}%`, height: `${box.height / viewport!.height * 100}%` }} />)}
      </div>}
    </div>
    {!ready && !error && <p role="status" className="mt-3 text-sm">Loading page preview…</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
    <p className="mt-3 text-xs opacity-75">The dark box is a preview. The downloaded PDF is rebuilt from page pixels, removing the original text layer.</p>
  </div>;
}
