import { CAPTION_MODEL_ID, CAPTION_MODEL_REVISION, captionDownloadProgress, normalizeCaptionOutput, validateCaptionRequest } from "./image-caption-config.mjs";
import { reportToolFailure } from "./diagnostics.mjs";

// A fresh worker per run keeps model loading and inference off the page thread.
// Terminating it cancels downloads/inference and releases its model memory.
self.addEventListener("message", async ({ data }) => {
  let model;
  try {
    const image = validateCaptionRequest(data);
    self.postMessage({ type: "progress", label: "Loading caption model…" });
    const { env, pipeline } = await import("@huggingface/transformers");
    env.backends.onnx.wasm.numThreads = 1;
    model = await pipeline("image-to-text", CAPTION_MODEL_ID, {
      revision: CAPTION_MODEL_REVISION,
      device: "wasm",
      dtype: "q8",
      progress_callback: (progress) => {
        const percent = captionDownloadProgress(progress);
        if (percent !== null) self.postMessage({ type: "progress", label: `Downloading model files… ${percent}%` });
      },
    });
    self.postMessage({ type: "progress", label: "Describing your image…" });
    const output = await model(image, { max_new_tokens: 48 });
    self.postMessage({ type: "result", caption: normalizeCaptionOutput(output) });
  } catch (error) {
    reportToolFailure(error);
    self.postMessage({ type: "error" });
  } finally {
    try { await model?.dispose?.(); }
    catch (error) { reportToolFailure(error); }
  }
});
