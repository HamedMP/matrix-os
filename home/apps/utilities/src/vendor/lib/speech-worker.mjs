import { prepareSpeechAudio } from "./audio-tools.mjs";

const MAX_MODEL_DOWNLOAD_BYTES = 150 * 1024 * 1024;
const MAX_SINGLE_MODEL_FILE_BYTES = 100 * 1024 * 1024;

export function createBoundedModelFetch(fetchImpl, { maxFileBytes = MAX_SINGLE_MODEL_FILE_BYTES, maxTotalBytes = MAX_MODEL_DOWNLOAD_BYTES, timeoutMs = 120_000 } = {}) {
  let downloaded = 0;
  return async (input, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timeout); init.signal?.removeEventListener("abort", abort); };
    try {
      const response = await fetchImpl(input, { ...init, signal: controller.signal });
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxFileBytes || downloaded + declared > maxTotalBytes) throw new Error("Model download exceeds the browser download limit.");
      if (!response.body) { cleanup(); return response; }
      let fileBytes = 0;
      const boundedBody = response.body.pipeThrough(new TransformStream({
        transform(chunk, transformController) {
          fileBytes += chunk.byteLength; downloaded += chunk.byteLength;
          if (fileBytes > maxFileBytes || downloaded > maxTotalBytes) { cleanup(); throw new Error("Model download exceeds the browser download limit."); }
          transformController.enqueue(chunk);
        },
        flush() { cleanup(); },
      }));
      return new Response(boundedBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { cleanup(); throw error; }
  };
}

if (typeof self !== "undefined") self.onmessage = async (event) => {
  const nativeFetch = self.fetch.bind(self);
  try {
    const pcm = prepareSpeechAudio(event.data.audio);
    self.postMessage({ type: "status", message: "Loading the English Whisper model locally…" });
    // Transformers.js v3 calls the worker's global fetch; env.fetch is not used by its hub loader.
    self.fetch = createBoundedModelFetch(nativeFetch);
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.numThreads = 1;
    const transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
      device: "wasm",
      dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
      progress_callback: (progress) => {
        if (progress.status === "progress" && Number.isFinite(progress.progress)) self.postMessage({ type: "progress", percent: Math.max(0, Math.min(100, Math.round(progress.progress))) });
      },
    });
    self.postMessage({ type: "status", message: "Transcribing on this device…" });
    const output = await transcriber(pcm, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
    const result = Array.isArray(output) ? output[0] : output;
    const duration = pcm.length / 16000;
    const chunks = Array.isArray(result?.chunks) ? result.chunks.map((chunk) => ({
      seconds: Math.max(0, Math.min(duration, Number(chunk.timestamp?.[0]) || 0)),
      text: String(chunk.text ?? "").trim(),
    })).filter((chunk) => chunk.text) : [];
    self.postMessage({ type: "done", text: String(result?.text ?? "").trim(), chunks });
  } catch {
    self.postMessage({ type: "error", message: "Local transcription could not run. Check browser storage, memory, and network access for the first model download." });
  } finally { self.fetch = nativeFetch; }
};
