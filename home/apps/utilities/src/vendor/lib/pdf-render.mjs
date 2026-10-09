import { PDFDocument } from "pdf-lib";

const MAX_PIXELS = 16_000_000;
const MAX_OUTPUT = 80 * 1024 * 1024;

export function validateRenderPageCount(count, maximum) {
  if (!Number.isInteger(count) || count < 1) throw new Error("PDF must contain pages.");
  if (count > maximum) throw new Error(`This operation supports up to ${maximum} pages.`);
  return count;
}

export function validateRedaction(value, pageCount, width, height) {
  const fields = Object.fromEntries(["page", "x", "y", "width", "height"].map((key) => [key, Number(value?.[key])]));
  if (!Number.isInteger(fields.page) || fields.page < 1 || fields.page > pageCount) throw new Error(`Choose a page from 1 to ${pageCount}.`);
  if (![fields.x, fields.y, fields.width, fields.height].every(Number.isFinite) || fields.width <= 0 || fields.height <= 0) throw new Error("Redaction width and height must be positive numbers.");
  if (fields.x < 0 || fields.y < 0 || fields.x + fields.width > width || fields.y + fields.height > height) throw new Error("Redaction rectangle must stay within the page.");
  return fields;
}

export function validateRedactionRegions(regions, pages) {
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 50) throw new Error("Add at least one redaction area, up to 50.");
  if (!Array.isArray(pages) || pages.length < 1) throw new Error("PDF must contain pages.");
  return regions.map((region) => {
    const page = Number(region?.page);
    if (!Number.isInteger(page) || page < 1 || page > pages.length) throw new Error(`Choose a page from 1 to ${pages.length}.`);
    return validateRedaction(region, pages.length, pages[page - 1].width, pages[page - 1].height);
  });
}

/** PDF.js PageViewport exposes point conversion, not rectangle conversion. */
export function pdfBoxToViewport(viewport, box) {
  const [x1, y1] = viewport.convertToViewportPoint(box.x, box.y);
  const [x2, y2] = viewport.convertToViewportPoint(box.x + box.width, box.y + box.height);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function viewportBoxToPdf(viewport, box) {
  const [x1, y1] = viewport.convertToPdfPoint(box.x, box.y);
  const [x2, y2] = viewport.convertToPdfPoint(box.x + box.width, box.y + box.height);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not export the rendered page.")), type, quality));
}

async function open(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 50 * 1024 * 1024 || bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("Choose a valid PDF of 50 MB or smaller.");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  return { task, document: await task.promise };
}

async function render(page, scale = 1.5) {
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  if (width * height > MAX_PIXELS) throw new Error("A page is too large to render on this device.");
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser cannot render the PDF page.");
  await page.render({ canvasContext: context, canvas, viewport }).promise;
  return { canvas, context, viewport };
}

/** Raster operations intentionally produce new pixels, never preserve hidden source text.
 * @param {(fraction: number) => void} progress
 */
export async function runRenderedPdfTool(slug, bytes, options = {}, progress = () => {}) {
  if (!["pdf-to-image", "redact-pdf", "ocr-pdf"].includes(slug)) throw new Error("Unknown rendered PDF task.");
  const { task, document: source } = await open(bytes);
  try {
    validateRenderPageCount(source.numPages, slug === "ocr-pdf" ? 10 : 20);
    if (slug === "pdf-to-image") {
      const { zipSync } = await import("fflate");
      const files = {};
      for (let i = 1; i <= source.numPages; i++) {
        const { canvas } = await render(await source.getPage(i));
        const blob = await toBlob(canvas, "image/png");
        files[`page-${String(i).padStart(3, "0")}.png`] = new Uint8Array(await blob.arrayBuffer());
        canvas.width = canvas.height = 0;
        progress(i / source.numPages);
      }
      const zipped = zipSync(files, { level: 0 });
      if (zipped.length > MAX_OUTPUT) throw new Error("Rendered pages exceed the 80 MB output limit.");
      return { bytes: zipped, mime: "application/zip", filename: "pdf-pages.zip", notice: "Each page is exported as a PNG image in the ZIP archive." };
    }
    if (slug === "redact-pdf") {
      const output = await PDFDocument.create();
      const pageSizes = [];
      for (let i = 1; i <= source.numPages; i++) {
        const page = await source.getPage(i);
        pageSizes.push({ width: page.view[2] - page.view[0], height: page.view[3] - page.view[1] });
      }
      const regions = validateRedactionRegions(options.regions ?? [options], pageSizes);
      for (let i = 1; i <= source.numPages; i++) {
        const page = await source.getPage(i);
        const { canvas, context, viewport } = await render(page, 1.5);
        for (const region of regions.filter((entry) => entry.page === i)) {
          const box = pdfBoxToViewport(viewport, region);
          context.fillStyle = "#000";
          context.fillRect(box.x, box.y, box.width, box.height);
        }
        const png = await output.embedPng(new Uint8Array(await (await toBlob(canvas, "image/png")).arrayBuffer()));
        const outPage = output.addPage([viewport.width / 1.5, viewport.height / 1.5]);
        outPage.drawImage(png, { x: 0, y: 0, width: outPage.getWidth(), height: outPage.getHeight() });
        canvas.width = canvas.height = 0;
        progress(i / source.numPages);
      }
      const result = new Uint8Array(await output.save());
      if (result.length > MAX_OUTPUT) throw new Error("Redacted PDF exceeds the 80 MB output limit.");
      return { bytes: result, mime: "application/pdf", filename: "redacted.pdf", notice: "All pages were rasterized; selectable text and interactive content were removed. Review every page before sharing." };
    }
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const text = [];
      for (let i = 1; i <= source.numPages; i++) {
        const { canvas } = await render(await source.getPage(i), 2);
        const result = await worker.recognize(canvas);
        text.push(`Page ${i}\n${result.data.text.trim()}`);
        canvas.width = canvas.height = 0;
        progress(i / source.numPages);
      }
      const output = text.join("\n\n");
      return { output, bytes: new TextEncoder().encode(output), mime: "text/plain", filename: "pdf-ocr.txt", notice: "OCR runs locally after downloading an English recognition model. Review the extracted text." };
    } finally { await worker.terminate(); }
  } finally { await task.destroy(); }
}
