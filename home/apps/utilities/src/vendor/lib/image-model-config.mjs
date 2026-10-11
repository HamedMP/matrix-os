// TinyCLIP weights and code are MIT licensed. The quantized ONNX model is 24.3 MB.
// https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX
export const TAG_MODEL_ID = "onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX";

export function validateTagModelRequest(data) {
  if (data?.type !== "run" || data.task !== "tags") throw new Error("Invalid image tag request.");
  if (!(data.blob instanceof Blob) || data.blob.type !== "image/png" || data.blob.size < 12) throw new Error("Choose a valid PNG image.");
  if (data.blob.size > 10 * 1024 * 1024) throw new Error("The prepared PNG must be at most 10 MB.");
  const labels = data.labels;
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 12 || labels.some((label) => typeof label !== "string" || label.length < 2 || label.length > 40 || !/^[\p{L}\p{N} -]+$/u.test(label))) throw new Error("Enter 2 to 12 valid labels.");
  if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) throw new Error("Use unique labels.");
  return labels;
}
