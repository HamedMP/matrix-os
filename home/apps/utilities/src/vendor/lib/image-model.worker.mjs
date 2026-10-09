import { TAG_MODEL_ID, validateTagModelRequest } from "./image-model-config.mjs";

// A dedicated worker keeps model inference off the page thread.
// It is terminated after each request, releasing model memory on cancellation.
self.addEventListener("message", async ({ data }) => {
  let model;
  try {
    if (data?.task === "tags") validateTagModelRequest(data);
    else if (data?.type !== "run" || data.task !== "portrait" || !(data.blob instanceof Blob) || data.blob.type !== "image/png" || data.blob.size < 12 || data.blob.size > 10 * 1024 * 1024) throw new Error("Invalid portrait request");
    self.postMessage({ type: "progress", label: data.task === "tags" ? "Loading image tag model…" : "Loading portrait model…" });
    const { pipeline } = await import("@huggingface/transformers");
    const options = {
      device: "wasm",
      dtype: "q8",
      progress_callback: (progress) => {
        if (progress.status === "progress" && Number.isFinite(progress.progress)) self.postMessage({ type: "progress", label: `Downloading model files… ${Math.max(0, Math.min(100, Math.round(progress.progress)))}%` });
      },
    };
    if (data.task === "tags") {
      model = await pipeline("zero-shot-image-classification", TAG_MODEL_ID, options);
      self.postMessage({ type: "progress", label: "Comparing your labels…" });
      const scores = await model(data.blob, data.labels);
      if (!Array.isArray(scores) || scores.length !== data.labels.length) throw new Error("Invalid tag scores");
      self.postMessage({ type: "result", scores });
      return;
    }
    model = await pipeline("background-removal", "Xenova/modnet", options);
    self.postMessage({ type: "progress", label: "Removing portrait background…" });
    const output = await model(data.blob);
    const image = output?.[0];
    if (!image || image.channels !== 4 || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 1024 || image.height > 1024) throw new Error("Invalid portrait result");
    const png = await image.toBlob("image/png");
    if (png.size < 12 || png.size > 50 * 1024 * 1024) throw new Error("Invalid portrait PNG");
    const bytes = await png.arrayBuffer();
    self.postMessage({ type: "result", bytes, mime: "image/png", width: image.width, height: image.height }, [bytes]);
  } catch (error) {
    console.error("Local image model failed", error);
    self.postMessage({ type: "error" });
  } finally { await model?.dispose?.(); }
});
