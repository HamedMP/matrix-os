import { imageOutputName, checkedImageBytes, renderImage } from "./image-tools.mjs";
import {
  validateSuperResolutionDimensions,
  validateSuperResolutionPixels,
  validateSuperResolutionRequest,
  validateSuperResolutionResult,
} from "./image-super-resolution-config.mjs";

function runSuperResolutionWorker(blob, width, height, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./image-super-resolution.worker.mjs", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error); else resolve(output);
    };
    const abort = () => finish(new DOMException("Image enhancement was cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new Error("AI enhancement took too long. Try a smaller image or another browser.")), 240_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new Error("This browser could not start the AI enhancement model."));
    worker.onmessageerror = () => finish(new Error("This browser could not read the enhanced image."));
    worker.onmessage = ({ data }) => {
      if (data?.type === "progress") {
        if (typeof data.label === "string" && data.label.length < 100) onProgress?.(data.label);
        return;
      }
      if (data?.type === "error") return finish(new Error("This browser could not enhance the image. Check your connection, available memory, and browser support."));
      if (data?.type === "result") {
        try { validateSuperResolutionPixels(data, width, height); return finish(null, data); }
        catch { return finish(new Error("The AI model returned invalid image pixels.")); }
      }
    };
    if (signal?.aborted) return abort();
    worker.postMessage({ type: "run", blob, width, height });
  });
}

async function encodePng(output, width, height) {
  const pixels = validateSuperResolutionPixels(output, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not create the enhanced image.");
    const image = context.createImageData(output.width, output.height);
    const channels = output.channels;
    for (let source = 0, target = 0; source < pixels.length; source += channels, target += 4) {
      image.data[target] = pixels[source];
      image.data[target + 1] = pixels[source + 1];
      image.data[target + 2] = pixels[source + 2];
      image.data[target + 3] = channels === 4 ? pixels[source + 3] : 255;
    }
    context.putImageData(image, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob?.type === "image/png" ? resolve(blob) : reject(new Error("This browser could not export the enhanced PNG.")), "image/png"));
  } finally { canvas.width = 0; canvas.height = 0; }
}

/** Run genuine 2× model inference locally, without sending the source image to a server. */
export async function upscaleImageLocally(file, onProgress, signal) {
  signal?.throwIfAborted();
  await checkedImageBytes(file);
  const image = await createImageBitmap(file);
  let width, height;
  try {
    width = image.width; height = image.height;
    validateSuperResolutionDimensions(width, height);
  } finally { image.close(); }
  signal?.throwIfAborted();
  onProgress?.("Preparing image…");
  const prepared = await renderImage(file, { format: "png" });
  validateSuperResolutionRequest({ type: "run", blob: prepared.blob, width, height });
  signal?.throwIfAborted();
  const output = await runSuperResolutionWorker(prepared.blob, width, height, onProgress, signal);
  signal?.throwIfAborted();
  onProgress?.("Preparing PNG…");
  const blob = await encodePng(output, width, height);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  validateSuperResolutionResult({ type: "result", bytes, width: output.width, height: output.height }, width, height);
  signal?.throwIfAborted();
  return { blob, filename: imageOutputName(`${file.name.replace(/\.[^.]+$/, "")}-ai-enhanced`, "png"), width: output.width, height: output.height, mime: "image/png" };
}
