import {
  SUPER_RESOLUTION_MODEL_ID,
  SUPER_RESOLUTION_MODEL_REVISION,
  modelDownloadProgress,
  validateSuperResolutionPixels,
  validateSuperResolutionRequest,
} from "./image-super-resolution-config.mjs";
import { reportToolFailure } from "./diagnostics.mjs";

// The worker owns the model for one run. Termination cancels inference and
// releases the model's memory instead of retaining it in a browser tab.
self.addEventListener("message", async ({ data }) => {
  let model;
  try {
    const blob = validateSuperResolutionRequest(data);
    self.postMessage({ type: "progress", label: "Loading AI enhancement model…" });
    const { env, pipeline } = await import("@huggingface/transformers");
    env.backends.onnx.wasm.numThreads = 1;
    model = await pipeline("image-to-image", SUPER_RESOLUTION_MODEL_ID, {
      revision: SUPER_RESOLUTION_MODEL_REVISION,
      device: "wasm",
      dtype: "q8",
      progress_callback: (progress) => {
        const percent = modelDownloadProgress(progress);
        if (percent !== null) self.postMessage({ type: "progress", label: `Downloading model… ${percent}%` });
      },
    });
    self.postMessage({ type: "progress", label: "Enhancing image detail…" });
    const output = await model(blob);
    const pixels = validateSuperResolutionPixels(output, data.width, data.height);
    const copy = new Uint8Array(pixels);
    self.postMessage({ type: "result", width: output.width, height: output.height, channels: output.channels, data: copy }, [copy.buffer]);
  } catch (error) {
    reportToolFailure(error);
    self.postMessage({ type: "error" });
  } finally {
    try { await model?.dispose?.(); }
    catch (error) { reportToolFailure(error); }
  }
});
