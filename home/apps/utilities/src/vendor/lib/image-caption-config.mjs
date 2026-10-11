// Browser-ready ONNX conversion of the Apache-2.0 nlpconnect model.
// https://huggingface.co/nlpconnect/vit-gpt2-image-captioning
// https://huggingface.co/Xenova/vit-gpt2-image-captioning
export const CAPTION_MODEL_ID = "Xenova/vit-gpt2-image-captioning";
export const CAPTION_MODEL_REVISION = "918fd8579b3bda533eb09955c1ab5ac25bafaf7a";
const MAX_PREPARED_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_FILE_BYTES = 300 * 1024 * 1024;

export function validateCaptionRequest(data) {
  if (data?.type !== "run" || !(data.blob instanceof Blob) || data.blob.type !== "image/png" || data.blob.size < 12) throw new Error("Choose a valid prepared PNG image.");
  if (data.blob.size > MAX_PREPARED_BYTES) throw new Error("The prepared PNG must be at most 10 MB.");
  return data.blob;
}

/** Remove only a complete "phrase with phrase" echo from short model captions. */
function collapseRepeatedCaptionSuffix(caption) {
  const punctuation = /[.!?]$/u.exec(caption)?.[0] ?? "";
  const words = (punctuation ? caption.slice(0, -1) : caption).split(" ");
  const connector = words.findIndex((word) => word.toLowerCase() === "with");
  if (connector < 3 || connector > 12 || words.length !== connector * 2 + 1) return caption;
  const first = words.slice(0, connector);
  const second = words.slice(connector + 1);
  if (!first.every((word, index) => word.toLowerCase() === second[index].toLowerCase())) return caption;
  return `${first.join(" ")}${punctuation}`;
}

export function normalizeCaptionOutput(output) {
  const value = Array.isArray(output) && output.length === 1 ? output[0]?.generated_text : null;
  if (typeof value !== "string" || value.length > 500 || /[<>\u0000-\u001f\u007f]/u.test(value)) throw new Error("The image model did not return a usable caption.");
  const caption = value.replace(/\s+/gu, " ").trim();
  if (caption.length < 3) throw new Error("The image model did not return a usable caption.");
  return collapseRepeatedCaptionSuffix(caption);
}

/** Only expose a number to the UI, never model file names or remote URLs. */
export function captionDownloadProgress(progress) {
  if (progress?.status !== "progress") return null;
  if (Number.isFinite(progress.total) && progress.total > MAX_MODEL_FILE_BYTES) throw new Error("The model download is larger than expected.");
  if (!Number.isFinite(progress.progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress.progress)));
}
