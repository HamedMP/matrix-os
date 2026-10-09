import { normalizeCaptionOutput, validateCaptionRequest } from "./image-caption-config.mjs";
import { reportToolFailure } from "./diagnostics.mjs";

export function runCaptionWorker(blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./image-caption.worker.mjs", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (error, caption) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error); else resolve(caption);
    };
    const abort = () => finish(new DOMException("Image captioning was cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Captioning took too long. Try a smaller image or another browser.")), 300_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new Error("This browser could not start the local caption model."));
    worker.onmessageerror = () => finish(new Error("This browser could not read the caption result."));
    worker.onmessage = ({ data }) => {
      if (data?.type === "progress") {
        if (typeof data.label === "string" && data.label.length < 100) onProgress?.(data.label);
        return;
      }
      if (data?.type === "error") return finish(new Error("This browser could not run the caption model. Check your connection, available memory, and browser support."));
      if (data?.type === "result") {
        try { return finish(null, normalizeCaptionOutput([{ generated_text: data.caption }])); }
        catch (error) { reportToolFailure(error); return finish(new Error("The local model returned an invalid caption.")); }
      }
    };
    if (signal?.aborted) return abort();
    worker.postMessage({ type: "run", blob });
  });
}

/** Prepare a bounded image, then caption it entirely in the browser worker. */
export async function captionImageLocally(file, onProgress, signal) {
  signal?.throwIfAborted();
  const { checkedImageBytes, renderImage } = await import("./image-tools.mjs");
  await checkedImageBytes(file);
  signal?.throwIfAborted();
  onProgress?.("Preparing image…");
  const prepared = await renderImage(file, { width: 512, height: 512, format: "png" });
  signal?.throwIfAborted();
  validateCaptionRequest({ type: "run", blob: prepared.blob });
  return runCaptionWorker(prepared.blob, onProgress, signal);
}
