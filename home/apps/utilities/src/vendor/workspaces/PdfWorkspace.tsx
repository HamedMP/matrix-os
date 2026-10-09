import { reportToolFailure } from "../lib/diagnostics.mjs";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download, FilePlus2, Play, RotateCcw } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";
import { PdfRedactionPreview } from "./PdfRedactionPreview";

type PdfResult = { bytes?: Uint8Array; mime?: string; filename?: string; notice?: string; output?: string };
type RedactionRegion = { page: number; x: number; y: number; width: number; height: number };
type WorkspacePage = { sourceIndex: number; pageIndex: number; rotation: 0 | 90 | 180 | 270 };
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const multi = new Set(["pdf-workspace", "merge-pdfs", "compare-pdfs"]);

function track(slug: string, action: "start" | "success" | "error" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

export function PdfWorkspace({ slug }: { slug: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [pages, setPages] = useState("1");
  const [degrees, setDegrees] = useState("90");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [password, setPassword] = useState("");
  const [x, setX] = useState("30");
  const [y, setY] = useState("50");
  const [rectWidth, setRectWidth] = useState("120");
  const [rectHeight, setRectHeight] = useState("30");
  const [redactPage, setRedactPage] = useState("1");
  const [redactPageCount, setRedactPageCount] = useState(0);
  const [redactionRegions, setRedactionRegions] = useState<RedactionRegion[]>([]);
  const [workspacePages, setWorkspacePages] = useState<WorkspacePage[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PdfResult | null>(null);
  const [url, setUrl] = useState("");
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  function invalidate() { version.current++; setBusy(false); setProgress(0); setResult(null); setError(""); }
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  useEffect(() => {
    if (slug !== "pdf-workspace" || !files.length) return;
    let cancelled = false;
    const tasks: Array<{ destroy(): Promise<void> }> = [];
    const destroyed = new Set<(typeof tasks)[number]>();
    const release = (task: (typeof tasks)[number]) => {
      if (destroyed.has(task)) return Promise.resolve();
      destroyed.add(task);
      return task.destroy().catch((cause: unknown) => reportToolFailure(cause));
    };
    setWorkspaceLoading(true);
    setWorkspaceError("");
    void (async () => {
      try {
        if (files.length > 10) throw new Error("Choose up to ten PDF files.");
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        const nextPages: WorkspacePage[] = [];
        const sources = [];
        for (const [sourceIndex, file] of files.entries()) {
          if (cancelled) return;
          if (file.size > MAX_FILE_BYTES) throw new Error("Each PDF must be 50 MB or smaller.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("Choose a valid PDF file.");
          const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
          tasks.push(task);
          const source = await task.promise;
          if (source.numPages < 1 || source.numPages > 200 || nextPages.length + source.numPages > 200) throw new Error("Combined PDF must have 200 pages or fewer.");
          sources.push(source);
          for (let pageIndex = 0; pageIndex < source.numPages; pageIndex++) nextPages.push({ sourceIndex, pageIndex, rotation: 0 });
        }
        if (cancelled) return;
        setWorkspacePages(nextPages);
        setWorkspaceLoading(false);
        const batch: Record<string, string> = {};
        for (const [sourceIndex, source] of sources.entries()) {
          for (let pageIndex = 0; pageIndex < source.numPages; pageIndex++) {
            if (cancelled) return;
            try {
              const page = await source.getPage(pageIndex + 1);
              const base = page.getViewport({ scale: 1 });
              const viewport = page.getViewport({ scale: Math.min(112 / base.width, 112 / base.height, 1) });
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.ceil(viewport.width));
              canvas.height = Math.max(1, Math.ceil(viewport.height));
              const context = canvas.getContext("2d", { alpha: false });
              if (!context) throw new Error("Preview is unavailable.");
              await page.render({ canvas, canvasContext: context, viewport }).promise;
              if (cancelled) return;
              batch[`${sourceIndex}:${pageIndex}`] = canvas.toDataURL("image/jpeg", 0.75);
            } catch (cause) {
              if (cancelled) return;
              // A page can still be reordered and exported when its thumbnail fails to render.
              reportToolFailure(cause);
            }
            if (Object.keys(batch).length >= 8) { setThumbnails((current) => ({ ...current, ...batch })); for (const key of Object.keys(batch)) delete batch[key]; }
          }
        }
        if (!cancelled && Object.keys(batch).length) setThumbnails((current) => ({ ...current, ...batch }));
      } catch (cause) {
        if (!cancelled) { setWorkspacePages([]); setWorkspaceError(cause instanceof Error ? cause.message : "Could not read these PDF pages."); setWorkspaceLoading(false); }
      } finally {
        await Promise.all(tasks.map(release));
      }
    })();
    return () => { cancelled = true; for (const task of tasks) void release(task); };
  }, [files, slug]);

  function movePage(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= workspacePages.length || to >= workspacePages.length) return;
    invalidate();
    setWorkspacePages((current) => { const next = [...current]; const [page] = next.splice(from, 1); next.splice(to, 0, page); return next; });
    setResult(null);
  }

  async function run() {
    const current = ++version.current;
    setError(""); setResult(null); setBusy(true); setProgress(0); track(slug, "start");
    try {
      if (!files.length) throw new Error("Choose a PDF file first.");
      if ((slug === "merge-pdfs" || slug === "compare-pdfs") && files.length < 2) throw new Error(slug === "compare-pdfs" ? "Choose two PDFs to compare." : "Choose at least two PDFs to combine.");
      if (slug === "compare-pdfs" && files.length !== 2) throw new Error("Choose exactly two PDFs to compare.");
      if (files.length > 10) throw new Error("Choose up to ten PDF files.");
      if (files.some((file) => file.size > MAX_FILE_BYTES)) throw new Error("Each PDF must be 50 MB or smaller.");
      if (slug === "redact-pdf" && !redactionRegions.length) throw new Error("Draw a box on the page or add precise coordinates first.");
      if (slug === "pdf-workspace" && (workspaceLoading || workspaceError || !workspacePages.length)) throw new Error("Wait for PDF pages to load before creating the document.");
      const bytes = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
      if (version.current !== current) return;
      const options = { text, pages, degrees, title, author, password, x, y, page: redactPage, width: rectWidth, height: rectHeight, regions: redactionRegions, pagePlan: workspacePages };
      let output: PdfResult;
      if (["pdf-to-image", "redact-pdf", "ocr-pdf"].includes(slug)) {
        const renderer = await import("../lib/pdf-render.mjs");
        if (version.current !== current) return;
        output = await renderer.runRenderedPdfTool(slug, bytes[0], options, (value: number) => { if (version.current === current) setProgress(value); });
      } else {
        const processor = await import("../lib/pdf-tools.mjs");
        if (version.current !== current) return;
        output = await processor.runPdfTool(slug, bytes, options);
      }
      if (version.current !== current) return;
      setResult(output); track(slug, "success");
    } catch (cause) {
      if (version.current !== current) return;
      setError(cause instanceof Error ? cause.message : "Could not process this PDF.");
      track(slug, "error", cause);
    } finally { if (version.current === current) setBusy(false); }
  }

  function download() {
    if (!result?.bytes || !result.mime || !result.filename) return;
    const blob = new Blob([new Uint8Array(result.bytes)], { type: result.mime });
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    const link = document.createElement("a"); link.href = nextUrl; link.download = result.filename; link.click();
    track(slug, "download");
  }

  function addRedaction(box: Omit<RedactionRegion, "page">) {
    if (redactionRegions.length >= 50) { setError("This tool supports up to 50 redaction areas."); return; }
    const region = { page: Number(redactPage), ...box };
    if (![region.page, region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) { setError("Enter valid positive coordinates before adding an area."); return; }
    invalidate();
    setRedactionRegions((current) => [...current, region]);
    setError(""); setResult(null);
  }

  return <div onChangeCapture={invalidate} className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <label htmlFor="pdf-files" className="mb-3 block text-base font-semibold">Your PDF {multi.has(slug) ? "files" : "file"}</label>
      <input id="pdf-files" type="file" accept="application/pdf,.pdf" multiple={multi.has(slug)} onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); setResult(null); setError(""); setRedactionRegions([]); setRedactPage("1"); setWorkspacePages([]); setThumbnails({}); setWorkspaceError(""); }} className="block w-full min-w-0 rounded-2xl border p-4 text-sm file:mr-4 file:rounded-full file:border-0 file:px-4 file:py-2" style={{ borderColor: `${c.deep}25` }} />
      {files.length > 0 && <ul className="mt-4 space-y-1 text-sm" aria-label="Selected PDFs">{files.map((file, index) => <li key={`${file.name}-${index}`} className="min-w-0 truncate">{index + 1}. {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</li>)}</ul>}
      {slug === "pdf-workspace" && files.length > 0 && <section className="mt-5" aria-label="Arrange PDF pages">
        <h2 className="text-sm font-semibold">Arrange pages</h2>
        <p className="mt-1 text-xs opacity-75">Drag cards or use the arrows to change page order. Choose a clockwise rotation for each page. The downloaded PDF follows this order.</p>
        {workspaceLoading && <p role="status" className="mt-3 text-sm">Reading PDF pages…</p>}
        {workspaceError && <p role="alert" className="mt-3 text-sm text-red-800">{workspaceError}</p>}
        {workspacePages.length > 0 && <ol className="mt-4 grid max-h-[70vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3" aria-label="PDF pages in output order">
          {workspacePages.map((item, index) => {
            const key = `${item.sourceIndex}:${item.pageIndex}`;
            return <li key={key} draggable onDragStart={(event) => { setDragIndex(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); if (dragIndex !== null) movePage(dragIndex, index); setDragIndex(null); }} onDragEnd={() => setDragIndex(null)} className="rounded-xl border bg-white p-2 text-xs shadow-sm" style={{ borderColor: `${c.deep}25`, opacity: dragIndex === index ? 0.55 : 1 }}>
              <div className="flex h-32 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
                {thumbnails[key] ? <img src={thumbnails[key]} alt={`Page ${item.pageIndex + 1} of ${files[item.sourceIndex]?.name ?? "PDF"}`} draggable={false} className="max-h-28 max-w-28 object-contain shadow-sm" style={{ transform: `rotate(${item.rotation}deg)` }} /> : <span className="px-2 text-center text-slate-500">Page {item.pageIndex + 1}</span>}
              </div>
              <p className="mt-2 font-semibold">Output page {index + 1}</p>
              <p className="truncate" title={files[item.sourceIndex]?.name}>{files[item.sourceIndex]?.name} · source page {item.pageIndex + 1}</p>
              <label className="mt-2 block">Clockwise rotation
                <select aria-label={`Rotate output page ${index + 1}`} value={item.rotation} onChange={(event) => { const rotation = Number(event.target.value) as WorkspacePage["rotation"]; setWorkspacePages((current) => current.map((page, currentIndex) => currentIndex === index ? { ...page, rotation } : page)); setResult(null); }} className="mt-1 w-full rounded-lg border p-2">
                  <option value="0">No rotation</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option>
                </select>
              </label>
              <div className="mt-2 flex gap-1"><button type="button" aria-label={`Move output page ${index + 1} earlier`} disabled={index === 0} onClick={() => movePage(index, index - 1)} className="flex flex-1 items-center justify-center rounded-lg border p-2 disabled:opacity-40"><ArrowUp className="size-4" /></button><button type="button" aria-label={`Move output page ${index + 1} later`} disabled={index === workspacePages.length - 1} onClick={() => movePage(index, index + 1)} className="flex flex-1 items-center justify-center rounded-lg border p-2 disabled:opacity-40"><ArrowDown className="size-4" /></button></div>
            </li>;
          })}
        </ol>}
      </section>}
      {slug === "split-pdf" && <label className="mt-5 block text-sm font-medium">Pages to extract<input value={pages} onChange={(event) => setPages(event.target.value)} placeholder="1,3-5" className="mt-2 w-full rounded-xl border p-3" /></label>}
      {slug === "rotate-pdf" && <label className="mt-5 block text-sm font-medium">Clockwise rotation<select value={degrees} onChange={(event) => setDegrees(event.target.value)} className="mt-2 w-full rounded-xl border p-3"><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>}
      {["watermark-pdf", "edit-pdf", "sign-pdf"].includes(slug) && <label className="mt-5 block text-sm font-medium">{slug === "sign-pdf" ? "Your name" : slug === "watermark-pdf" ? "Watermark text" : "Text to add"}<input value={text} onChange={(event) => setText(event.target.value)} maxLength={1000} className="mt-2 w-full rounded-xl border p-3" /></label>}
      {["edit-pdf", "sign-pdf"].includes(slug) && <div className="mt-4 grid grid-cols-2 gap-3"><label className="text-sm font-medium">X position<input type="number" min="0" value={x} onChange={(event) => setX(event.target.value)} className="mt-2 w-full rounded-xl border p-3" /></label><label className="text-sm font-medium">Y position<input type="number" min="0" value={y} onChange={(event) => setY(event.target.value)} className="mt-2 w-full rounded-xl border p-3" /></label></div>}
      {slug === "redact-pdf" && <fieldset className="mt-5"><legend className="text-sm font-semibold">Redaction areas</legend>
        <label className="mt-2 block text-sm">Page {redactPageCount ? `of ${redactPageCount}` : ""}<input type="number" min="1" max={redactPageCount || undefined} value={redactPage} onChange={(event) => setRedactPage(event.target.value)} className="mt-1 w-full rounded-xl border p-3" /></label>
        {files[0] && <PdfRedactionPreview file={files[0]} page={Number(redactPage)} boxes={redactionRegions.filter((region) => region.page === Number(redactPage))} onBox={(box) => addRedaction(box)} onPageCount={setRedactPageCount} />}
        <details className="mt-4 rounded-xl border p-4" style={{ borderColor: `${c.deep}25` }}><summary className="cursor-pointer text-sm font-medium">Add precise coordinates instead</summary><p className="mt-3 text-xs">PDF points are measured from the bottom-left corner of the page.</p>
          <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-sm">X<input type="number" min="0" value={x} onChange={(event) => setX(event.target.value)} className="mt-1 w-full rounded-xl border p-3" /></label><label className="text-sm">Y<input type="number" min="0" value={y} onChange={(event) => setY(event.target.value)} className="mt-1 w-full rounded-xl border p-3" /></label><label className="text-sm">Width<input type="number" min="1" value={rectWidth} onChange={(event) => setRectWidth(event.target.value)} className="mt-1 w-full rounded-xl border p-3" /></label><label className="text-sm">Height<input type="number" min="1" value={rectHeight} onChange={(event) => setRectHeight(event.target.value)} className="mt-1 w-full rounded-xl border p-3" /></label></div>
          <button type="button" onClick={() => addRedaction({ x: Number(x), y: Number(y), width: Number(rectWidth), height: Number(rectHeight) })} className="mt-3 rounded-full border px-4 py-2 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}>Add area</button>
        </details>
        {redactionRegions.length > 0 && <div className="mt-4 rounded-xl border p-3" style={{ borderColor: `${c.deep}25` }}><p className="text-sm font-semibold">Selected areas ({redactionRegions.length}/50)</p><ul className="mt-2 max-h-36 space-y-2 overflow-auto text-xs">{redactionRegions.map((region, index) => <li key={`${index}-${region.page}`} className="flex items-center justify-between gap-2"><span>Page {region.page}: {Math.round(region.width)} × {Math.round(region.height)} pt</span><button type="button" onClick={() => { invalidate(); setRedactionRegions((current) => current.filter((_, item) => item !== index)); setResult(null); }} className="rounded-full border px-2 py-1">Remove</button></li>)}</ul></div>}
        <p className="mt-2 text-xs">Every page becomes an image. Review the downloaded PDF before sharing.</p>
      </fieldset>}
      {slug === "edit-pdf-metadata" && <div className="mt-5 grid gap-3"><label className="text-sm font-medium">Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} className="mt-2 w-full rounded-xl border p-3" /></label><label className="text-sm font-medium">Author<input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={300} className="mt-2 w-full rounded-xl border p-3" /></label></div>}
      {["protect-pdf", "unlock-pdf"].includes(slug) && <label className="mt-5 block text-sm font-medium">PDF password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} autoComplete="off" className="mt-2 w-full rounded-xl border p-3" /></label>}
      <div className="mt-6 flex flex-wrap gap-2"><button type="button" onClick={run} disabled={busy || !files.length || (slug === "redact-pdf" && !redactionRegions.length) || (slug === "pdf-workspace" && (workspaceLoading || !!workspaceError || !workspacePages.length))} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><Play className="size-4" />{busy ? "Working…" : slug === "redact-pdf" ? "Create redacted PDF" : slug === "pdf-workspace" ? "Create arranged PDF" : "Process PDF"}</button><button type="button" onClick={() => { invalidate(); setFiles([]); setResult(null); setError(""); setRedactionRegions([]); setWorkspacePages([]); setThumbnails({}); setWorkspaceError(""); const input = document.getElementById("pdf-files") as HTMLInputElement | null; if (input) input.value = ""; }} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}><RotateCcw className="size-4" />Clear</button></div>{busy && progress > 0 && <p role="status" className="mt-3 text-sm">{Math.round(progress * 100)}% complete</p>}
    </div>
    <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-base font-semibold">Result</h2>{error ? <p role="alert" className="mt-5 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p> : result ? <div className="mt-8 space-y-5"><FilePlus2 className="size-10" />{result.output ? <p className="max-h-96 overflow-auto whitespace-pre-wrap break-words">{result.output}</p> : <p>Your file is ready.</p>}{result.notice && <p className="text-sm text-white/75">{result.notice}</p>}{result.bytes && <button type="button" onClick={download} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold" style={{ color: c.deep }}><Download className="size-4" />Download {result.filename?.split(".").pop()?.toUpperCase()}</button>}</div> : <div className="mt-5 flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/60">Your processed result will be ready here. The files stay in this browser tab.</div>}</div>
  </div>;
}
