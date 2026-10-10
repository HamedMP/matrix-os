import { PDFDocument } from "pdf-lib";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_SIDE = 8_192;
const OUTPUT_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Check the actual file signature. Browser supplied MIME labels can be spoofed. */
export function inspectImageBytes(bytes, declaredType) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) throw new Error("Choose a valid image file.");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Each image must be 20 MB or smaller.");
  let actual;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) actual = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) actual = "image/jpeg";
  else if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") actual = "image/webp";
  else throw new Error("Choose a valid PNG, JPEG, or WebP image.");
  if (declaredType && declaredType !== "application/octet-stream" && declaredType !== actual) throw new Error("The file type does not match the image data.");
  return actual;
}

export function validateImageDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error("Could not read the image dimensions.");
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_IMAGE_PIXELS) throw new Error("Images must be at most 8,192 pixels per side and 32 million pixels total.");
  return { width, height };
}

export function calculateDimensions(sourceWidth, sourceHeight, width, height, stretch = false) {
  validateImageDimensions(sourceWidth, sourceHeight);
  const targetWidth = Number(width), targetHeight = Number(height);
  if (!Number.isSafeInteger(targetWidth) || !Number.isSafeInteger(targetHeight) || targetWidth < 1 || targetHeight < 1 || targetWidth > MAX_SIDE || targetHeight > MAX_SIDE) throw new Error("Width and height must be 1 to 8,192 pixels.");
  if (stretch) return validateImageDimensions(targetWidth, targetHeight);
  const scale = Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight);
  return validateImageDimensions(Math.max(1, Math.round(sourceWidth * scale)), Math.max(1, Math.round(sourceHeight * scale)));
}

export function calculateUpscaleDimensions(sourceWidth, sourceHeight, factor) {
  validateImageDimensions(sourceWidth, sourceHeight);
  if (factor !== 2 && factor !== 4) throw new Error("Choose 2× or 4× enlargement.");
  return validateImageDimensions(sourceWidth * factor, sourceHeight * factor);
}

/** MediaPipe returns boxes in the coordinates of its input bitmap. Add generous privacy margins. */
export function expandedFaceBox(box, width, height) {
  validateImageDimensions(width, height);
  if (!box || [box.originX, box.originY, box.width, box.height].some((value) => !Number.isFinite(value)) || box.width <= 0 || box.height <= 0) throw new Error("Could not read a detected face box.");
  const padX = Math.round(box.width * 0.15), padY = Math.round(box.height * 0.15);
  const x = Math.max(0, Math.floor(box.originX - padX));
  const y = Math.max(0, Math.floor(box.originY - padY));
  const right = Math.min(width, Math.ceil(box.originX + box.width + padX));
  const bottom = Math.min(height, Math.ceil(box.originY + box.height + padY));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function imageOutputName(name, format) {
  if (!Object.hasOwn(OUTPUT_TYPES, format)) throw new Error("Choose PNG, JPEG, or WebP output.");
  const last = String(name || "image").replaceAll("\\", "/").split("/").pop() || "image";
  const stem = last.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}._ -]/gu, "-").slice(0, 80) || "image";
  return `${stem}.${format === "jpeg" ? "jpg" : format}`;
}

export function readPixelColor(imageData, x, y) {
  if (!imageData || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) throw new Error("Choose a point inside the image.");
  const i = (y * imageData.width + x) * 4;
  const [red, green, blue, alpha] = imageData.data.slice(i, i + 4);
  if ([red, green, blue, alpha].some((v) => v === undefined)) throw new Error("Could not sample this image point.");
  return { hex: `#${[red, green, blue].map((v) => v.toString(16).padStart(2, "0")).join("")}`, rgba: `rgba(${red}, ${green}, ${blue}, ${Number((alpha / 255).toFixed(3))})`, red, green, blue, alpha };
}

/** Translate a click on an object-fit: contain preview to a real source pixel. */
export function imagePointFromClick(rect, naturalWidth, naturalHeight, clientX, clientY) {
  validateImageDimensions(naturalWidth, naturalHeight);
  if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error("Could not read the image preview.");
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const drawnWidth = naturalWidth * scale, drawnHeight = naturalHeight * scale;
  const left = rect.left + (rect.width - drawnWidth) / 2, top = rect.top + (rect.height - drawnHeight) / 2;
  if (clientX < left || clientX >= left + drawnWidth || clientY < top || clientY >= top + drawnHeight) throw new Error("Click inside the visible image to pick a color.");
  return { x: Math.min(naturalWidth - 1, Math.floor((clientX - left) / scale)), y: Math.min(naturalHeight - 1, Math.floor((clientY - top) / scale)) };
}

/** Read only basic, non-location EXIF fields from a bounded JPEG APP1 block. */
export function parseJpegExif(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 0xff || bytes[1] !== 0xd8) return {};
  const end = Math.min(bytes.length, 262_144);
  for (let p = 2; p + 4 < end;) {
    if (bytes[p] !== 0xff) break;
    const marker = bytes[p + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (length < 2 || p + 2 + length > end) break;
    if (marker === 0xe1 && String.fromCharCode(...bytes.slice(p + 4, p + 10)) === "Exif\0\0") {
      const start = p + 10, limit = p + 2 + length;
      const le = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
      const be = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
      if (!le && !be) return {};
      const u16 = (at) => at + 2 <= limit ? le ? bytes[at] | bytes[at + 1] << 8 : bytes[at] << 8 | bytes[at + 1] : -1;
      const u32 = (at) => at + 4 <= limit ? le ? ((bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0) : ((bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0) : -1;
      if (u16(start + 2) !== 42) return {};
      const ifd = start + u32(start + 4);
      if (ifd < start || ifd + 2 > limit) return {};
      const count = Math.min(u16(ifd), 100);
      const result = {};
      for (let j = 0; j < count && ifd + 2 + (j + 1) * 12 <= limit; j++) {
        const at = ifd + 2 + j * 12, tag = u16(at), type = u16(at + 2), size = u32(at + 4);
        if (tag === 0x0112 && type === 3 && size === 1) {
          const value = u16(at + 8);
          if (value >= 1 && value <= 8) result.orientation = value;
        }
        const key = { 0x010f: "make", 0x0110: "model", 0x0132: "capturedAt" }[tag];
        if (key && type === 2 && size > 1 && size <= 128) {
          const pos = size <= 4 ? at + 8 : start + u32(at + 8);
          if (pos >= start && pos + size <= limit) {
            const value = new TextDecoder("ascii").decode(bytes.slice(pos, pos + size)).replace(/\0.*$/s, "").trim();
            if (value) result[key] = value;
          }
        }
      }
      return result;
    }
    p += 2 + length;
  }
  return {};
}

export async function checkedImageBytes(file) {
  if (!file || typeof file.arrayBuffer !== "function" || file.size < 12 || file.size > MAX_IMAGE_BYTES) throw new Error("Choose an image file of 20 MB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = inspectImageBytes(bytes, file.type);
  return { bytes, mime };
}

async function decodedImage(file, alreadyChecked = false) {
  const mime = alreadyChecked ? file.type : (await checkedImageBytes(file)).mime;
  try {
    const image = await createImageBitmap(file);
    try { validateImageDimensions(image.width, image.height); }
    catch (cause) { reportToolFailure(cause); image.close(); throw cause; }
    return { image, mime };
  } catch (error) {
    if (error instanceof Error && /8,192|32 million/.test(error.message)) throw error;
    reportToolFailure(error);
    throw new Error("Could not decode this image in your browser.");
  }
}

function canvasFor(width, height) {
  validateImageDimensions(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: false });
  if (!context) throw new Error("Your browser could not start image processing.");
  return { canvas, context };
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || blob.type !== mime) reject(new Error("This browser cannot export the chosen image format."));
    else if (blob.size > MAX_OUTPUT_BYTES) reject(new Error("The result is larger than 50 MB. Try a smaller image or lower quality."));
    else resolve(blob);
  }, mime, quality));
}

export async function renderImage(file, { width, height, format = "webp", quality = 0.82, stretch = false } = {}) {
  if (!Object.hasOwn(OUTPUT_TYPES, format)) throw new Error("Choose PNG, JPEG, or WebP output.");
  const q = Number(quality);
  if (!Number.isFinite(q) || q < 0.1 || q > 1) throw new Error("Quality must be between 10% and 100%.");
  const { image } = await decodedImage(file);
  try {
    const size = width === undefined && height === undefined ? { width: image.width, height: image.height } : calculateDimensions(image.width, image.height, width, height, stretch);
    const { canvas, context } = canvasFor(size.width, size.height);
    try {
      if (format === "jpeg") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, size.width, size.height); }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, size.width, size.height);
      const blob = await canvasBlob(canvas, OUTPUT_TYPES[format], q);
      return { blob, filename: imageOutputName(file.name, format), width: size.width, height: size.height, mime: OUTPUT_TYPES[format] };
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { image.close(); }
}

export async function upscaleImage(file, factor = 2) {
  const { image } = await decodedImage(file);
  try {
    const { width, height } = calculateUpscaleDimensions(image.width, image.height, factor);
    const { canvas, context } = canvasFor(width, height);
    try {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, width, height);
      const blob = await canvasBlob(canvas, "image/webp", 0.94);
      return { blob, filename: imageOutputName(`${file.name.replace(/\.[^.]+$/, "")}-upscaled`, "webp"), width, height, mime: "image/webp" };
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { image.close(); }
}

export function validatePortraitResult(result) {
  if (result?.mime !== "image/png" || !(result.bytes instanceof Uint8Array) || result.bytes.length < 12 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => result.bytes[index] === byte)) throw new Error("The portrait model did not return a valid PNG.");
  if (result.bytes.length > MAX_OUTPUT_BYTES) throw new Error("The result is larger than 50 MB.");
  const { width, height } = validateImageDimensions(result.width, result.height);
  if (width > 1024 || height > 1024) throw new Error("The portrait result must be at most 1,024 pixels per side.");
  return { width, height };
}

export function parseImageLabels(value) {
  if (typeof value !== "string" || value.length > 500) throw new Error("Enter 2 to 12 labels separated by commas.");
  const labels = value.split(",").map((label) => label.trim());
  if (labels.length < 2 || labels.length > 12 || labels.some((label) => !label)) throw new Error("Enter 2 to 12 labels separated by commas.");
  if (labels.some((label) => label.length > 40 || label.length < 2 || !/^[\p{L}\p{N} -]+$/u.test(label))) throw new Error("Each label must be 2 to 40 letters, numbers, spaces, or hyphens.");
  if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) throw new Error("Use unique labels.");
  return labels;
}

export function normalizeImageTagScores(output, labels) {
  if (!Array.isArray(output) || output.length < 1 || output.length > labels.length) throw new Error("Unexpected image tag model output.");
  const allowed = new Map(labels.map((label) => [label.toLocaleLowerCase(), label]));
  const seen = new Set();
  const scores = output.map((item) => {
    const key = typeof item?.label === "string" ? item.label.toLocaleLowerCase() : "";
    if (!allowed.has(key) || seen.has(key) || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) throw new Error("Unexpected image tag model output.");
    seen.add(key);
    return { label: allowed.get(key), score: Math.round(item.score * 100) };
  });
  return scores.sort((a, b) => b.score - a.score);
}

/** A fresh worker per request bounds model memory and makes cancellation immediate. */
function runImageModelWorker(task, blob, labels, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./image-model.worker.mjs", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new DOMException("Image processing was cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new Error("The image model took too long. Try a smaller image or another browser.")), 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(new Error("This browser could not start the image model."));
    worker.onmessage = ({ data }) => {
      if (data?.type === "progress") { if (typeof data.label === "string" && data.label.length < 100) onProgress?.(data.label); return; }
      if (data?.type === "error") { finish(new Error("This browser could not run the image model. Check your connection, available memory, and browser support.")); return; }
      if (data?.type !== "result") return;
      finish(null, data);
    };
    if (signal?.aborted) { abort(); return; }
    worker.postMessage({ type: "run", task, blob, labels });
  });
}

/** Local portrait matting; content never leaves the browser. */
export async function removePortraitBackground(file, onProgress, signal) {
  signal?.throwIfAborted();
  await checkedImageBytes(file);
  const prepared = await renderImage(file, { width: 1024, height: 1024, format: "png" });
  signal?.throwIfAborted();
  const data = await runImageModelWorker("portrait", prepared.blob, null, onProgress, signal);
  const bytes = new Uint8Array(data.bytes);
  const size = validatePortraitResult({ bytes, mime: data.mime, width: data.width, height: data.height });
  return { blob: new Blob([bytes], { type: "image/png" }), filename: imageOutputName(`${file.name.replace(/\.[^.]+$/, "")}-background-removed`, "png"), ...size };
}

/** Compare only user-supplied candidate labels; scores are relative to that list. */
export async function classifyImageLabels(file, labelText, onProgress, signal) {
  const labels = parseImageLabels(labelText);
  signal?.throwIfAborted();
  await checkedImageBytes(file);
  const prepared = await renderImage(file, { width: 1024, height: 1024, format: "png" });
  signal?.throwIfAborted();
  const data = await runImageModelWorker("tags", prepared.blob, labels, onProgress, signal);
  return normalizeImageTagScores(data.scores, labels);
}

const FACE_MODEL = new URL("./tools/models/mediapipe/blaze_face_short_range.tflite", document.baseURI).href;
const FACE_WASM = new URL("./tools/models/mediapipe", document.baseURI).href;

/** MediaPipe sends this normal CPU initialization notice to console.error. */
function filterMediapipeInfo(logger) {
  const original = logger.error;
  logger.error = (...args) => {
    if (args.length === 1 && args[0] === "INFO: Created TensorFlow Lite XNNPACK delegate for CPU.") return;
    return original.apply(logger, args);
  };
  return () => { logger.error = original; };
}

export function withMediapipeInfoFiltered(callback, logger = console) {
  const restore = filterMediapipeInfo(logger);
  try { return callback(); }
  finally { restore(); }
}

export async function withMediapipeInfoFilteredAsync(callback, logger = console) {
  const restore = filterMediapipeInfo(logger);
  try { return await callback(); }
  finally { restore(); }
}

export async function blurFaces(file, onProgress, signal) {
  signal?.throwIfAborted();
  const { image } = await decodedImage(file);
  let detector;
  try {
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height), Math.sqrt(2_000_000 / (image.width * image.height)));
    const detectWidth = Math.max(1, Math.round(image.width * scale));
    const detectHeight = Math.max(1, Math.round(image.height * scale));
    const { canvas: detectCanvas, context: detectContext } = canvasFor(detectWidth, detectHeight);
    try {
      detectContext.drawImage(image, 0, 0, detectWidth, detectHeight);
      onProgress?.("Downloading face detection model…");
      const response = await fetch(FACE_MODEL, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("Could not download the face detection model. Try again later.");
      const model = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      if (model.byteLength < 100_000 || model.byteLength > 10_000_000) throw new Error("The face detection model could not be verified.");
      const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const wasm = await FilesetResolver.forVisionTasks(FACE_WASM);
      detector = await withMediapipeInfoFilteredAsync(() => FaceDetector.createFromOptions(wasm, { baseOptions: { modelAssetBuffer: model }, runningMode: "IMAGE", minDetectionConfidence: 0.5 }));
      signal?.throwIfAborted();
      onProgress?.("Detecting faces…");
      const detections = withMediapipeInfoFiltered(() => detector.detect(detectCanvas)).detections ?? [];
      signal?.throwIfAborted();
      if (detections.length === 0) return { count: 0, blob: null };
      if (detections.length > 100 || detections.some((detection) => !detection.boundingBox)) throw new Error("Could not safely process every detected face. Try a smaller group photo.");
      const { canvas, context } = canvasFor(image.width, image.height);
      try {
        context.drawImage(image, 0, 0);
        for (const detection of detections) {
          const box = expandedFaceBox(detection.boundingBox, detectWidth, detectHeight);
          const x = Math.max(0, Math.floor(box.x * image.width / detectWidth));
          const y = Math.max(0, Math.floor(box.y * image.height / detectHeight));
          const right = Math.min(image.width, Math.ceil((box.x + box.width) * image.width / detectWidth));
          const bottom = Math.min(image.height, Math.ceil((box.y + box.height) * image.height / detectHeight));
          const w = right - x, h = bottom - y;
          if (w < 1 || h < 1) continue;
          // Coarse pixelation permanently removes face details and works across browsers.
          const tile = document.createElement("canvas");
          tile.width = Math.max(1, Math.ceil(w / 18)); tile.height = Math.max(1, Math.ceil(h / 18));
          const tileContext = tile.getContext("2d");
          if (!tileContext) throw new Error("Your browser could not blur the detected faces.");
          tileContext.drawImage(image, x, y, w, h, 0, 0, tile.width, tile.height);
          context.imageSmoothingEnabled = false;
          context.drawImage(tile, 0, 0, tile.width, tile.height, x, y, w, h);
          tile.width = 0; tile.height = 0;
        }
        const blob = await canvasBlob(canvas, "image/png");
        return { count: detections.length, blob, filename: imageOutputName(`${file.name.replace(/\.[^.]+$/, "")}-faces-blurred`, "png"), width: image.width, height: image.height };
      } finally { canvas.width = 0; canvas.height = 0; }
    } finally { detectCanvas.width = 0; detectCanvas.height = 0; }
  } finally { detector?.close(); image.close(); }
}

export async function inspectImageFile(file) {
  const { bytes, mime } = await checkedImageBytes(file);
  const { image } = await decodedImage(file, true);
  const modified = new Date(file.lastModified);
  try { return { name: file.name, format: mime, bytes: file.size, width: image.width, height: image.height, lastModified: Number.isFinite(modified.getTime()) ? modified.toISOString() : null, ...(mime === "image/jpeg" ? { exif: parseJpegExif(bytes) } : {}) }; }
  finally { image.close(); }
}

/** Feed only signature-checked PNG/JPEG bytes into pdf-lib. */
export async function runImageToPdf(images, types) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 10 || !Array.isArray(types) || images.length !== types.length) throw new Error("Choose 1 to 10 images.");
  if (images.reduce((sum, bytes) => sum + (bytes instanceof Uint8Array ? bytes.length : 0), 0) > 60 * 1024 * 1024) throw new Error("Choose no more than 60 MB of images at once.");
  const pdf = await PDFDocument.create();
  let totalPixels = 0;
  for (let i = 0; i < images.length; i++) {
    const mime = inspectImageBytes(images[i], types[i]);
    if (mime !== "image/png" && mime !== "image/jpeg") throw new Error("Convert WebP images to PNG or JPEG before adding them to a PDF.");
    let embedded;
    try { embedded = mime === "image/png" ? await pdf.embedPng(images[i]) : await pdf.embedJpg(images[i]); }
    catch (error) { reportToolFailure(error); throw new Error("Could not read one of these images."); }
    validateImageDimensions(embedded.width, embedded.height);
    totalPixels += embedded.width * embedded.height;
    if (totalPixels > 60_000_000) throw new Error("Combined images must have no more than 60 million pixels.");
    const scale = Math.min(1, 595 / embedded.width, 842 / embedded.height);
    const width = embedded.width * scale, height = embedded.height * scale;
    const page = pdf.addPage([Math.max(1, width), Math.max(1, height)]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }
  const bytes = new Uint8Array(await pdf.save());
  if (bytes.length > MAX_OUTPUT_BYTES) throw new Error("The PDF is larger than 50 MB. Use smaller images.");
  return { bytes, mime: "application/pdf", filename: "images.pdf" };
}

export async function imagesToPdf(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw new Error("Choose 1 to 10 images.");
  if (files.reduce((sum, file) => sum + (Number(file?.size) || 0), 0) > 60 * 1024 * 1024) throw new Error("Choose no more than 60 MB of images at once.");
  const images = [], types = [];
  for (const file of files) {
    const { bytes, mime } = await checkedImageBytes(file);
    if (mime === "image/webp" || mime === "image/jpeg" && (parseJpegExif(bytes).orientation ?? 1) > 1) {
      const outputFormat = mime === "image/jpeg" ? "jpeg" : "png";
      const converted = await renderImage(file, { format: outputFormat, quality: 0.92 });
      images.push(new Uint8Array(await converted.blob.arrayBuffer())); types.push(converted.mime);
    } else { images.push(bytes); types.push(mime); }
  }
  return runImageToPdf(images, types);
}

export async function recognizeImageText(file, onProgress) {
  await checkedImageBytes(file);
  const { createWorker } = await import("tesseract.js");
  let worker;
  try {
    worker = await createWorker("eng", 1, { logger: (message) => { if (message.status === "recognizing text") onProgress?.(Math.round((message.progress || 0) * 100)); } });
    const { data } = await worker.recognize(file);
    return String(data.text || "").slice(0, 100_000);
  } finally { if (worker) await worker.terminate(); }
}
import { reportToolFailure } from "./diagnostics.mjs";
