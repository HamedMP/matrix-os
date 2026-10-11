// Browser-ready ONNX conversion of the Apache-2.0 Swin2SR lightweight 2x model.
// https://huggingface.co/caidas/swin2SR-lightweight-x2-64
// https://huggingface.co/Xenova/swin2SR-lightweight-x2-64
export const SUPER_RESOLUTION_MODEL_ID = "Xenova/swin2SR-lightweight-x2-64";
export const SUPER_RESOLUTION_MODEL_REVISION = "54ccc3f9ed678912a9c47dc14f6c478855380a2b";
export const MAX_SUPER_RESOLUTION_SIDE = 256;
export const MAX_SUPER_RESOLUTION_PIXELS = 32_768;
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_FILE_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function validateSuperResolutionDimensions(width, height) {
  if (![width, height].every((size) => Number.isSafeInteger(size) && size > 0)) throw new Error("Could not read the image dimensions.");
  if (width > MAX_SUPER_RESOLUTION_SIDE || height > MAX_SUPER_RESOLUTION_SIDE) throw new Error("AI enhancement supports images up to 256 pixels per side. Choose smooth enlargement for a larger image.");
  if (width * height > MAX_SUPER_RESOLUTION_PIXELS) throw new Error("AI enhancement supports at most 32,768 input pixels. Choose smooth enlargement for a larger image.");
}

export function validateSuperResolutionRequest(data) {
  if (data?.type !== "run" || !(data.blob instanceof Blob) || data.blob.type !== "image/png" || data.blob.size < 12) throw new Error("Choose a valid prepared PNG image.");
  if (data.blob.size > MAX_INPUT_BYTES) throw new Error("The prepared PNG must be at most 5 MB.");
  validateSuperResolutionDimensions(data.width, data.height);
  return data.blob;
}

export function validateSuperResolutionPixels(output, inputWidth, inputHeight) {
  validateSuperResolutionDimensions(inputWidth, inputHeight);
  if (output?.width !== inputWidth * 2 || output?.height !== inputHeight * 2) throw new Error("The model returned unexpected dimensions.");
  if (![3, 4].includes(output.channels) || !(output.data instanceof Uint8Array) || output.data.length !== output.width * output.height * output.channels) throw new Error("The model returned invalid pixel data.");
  return output.data;
}

export function validateSuperResolutionResult(result, inputWidth, inputHeight) {
  validateSuperResolutionDimensions(inputWidth, inputHeight);
  const bytes = result?.bytes;
  if (result?.type !== "result" || !(bytes instanceof Uint8Array) || bytes.length < 12 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error("The model did not return a valid PNG.");
  if (bytes.length > MAX_OUTPUT_BYTES) throw new Error("The enhanced image is larger than 8 MB.");
  if (result.width !== inputWidth * 2 || result.height !== inputHeight * 2) throw new Error("The model returned unexpected dimensions.");
  return { bytes, width: result.width, height: result.height };
}

export function modelDownloadProgress(progress) {
  if (progress?.status !== "progress") return null;
  if (Number.isFinite(progress.total) && progress.total > MAX_MODEL_FILE_BYTES) throw new Error("The model download is larger than expected.");
  if (!Number.isFinite(progress.progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress.progress)));
}
