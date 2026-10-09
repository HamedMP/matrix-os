import { buildPdfNarration, joinNarrationAudio, PDF_NARRATION_MODEL_ID, PDF_NARRATION_VOICES, wavFromNarration } from "./pdf-podcast.mjs";
import { createBoundedNarrationFetch } from "./pdf-podcast-fetch.mjs";

self.onmessage = async ({ data }) => {
  const nativeFetch = self.fetch.bind(self);
  try {
    const plan = buildPdfNarration([[data.text]]);
    if (!PDF_NARRATION_VOICES.some((voice) => voice.id === data.voice)) throw new Error("Choose a supported English voice.");
    if (!Number.isFinite(data.speed) || data.speed < 0.8 || data.speed > 1.2) throw new Error("Choose a speed between 0.8 and 1.2.");
    self.postMessage({ type: "progress", status: "Downloading and preparing the local voice model…", completed: 0, total: plan.chunks.length });
    self.fetch = createBoundedNarrationFetch(nativeFetch);
    const [{ KokoroTTS }, { env }] = await Promise.all([import("kokoro-js"), import("@huggingface/transformers")]);
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.numThreads = 1;
    const tts = await KokoroTTS.from_pretrained(PDF_NARRATION_MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      progress_callback: ({ status, progress }) => {
        if (status === "progress" && Number.isFinite(progress)) self.postMessage({ type: "progress", status: `Preparing voice model (${Math.round(progress)}%)…`, completed: 0, total: plan.chunks.length });
      },
    });
    const parts = [];
    for (const [index, chunk] of plan.chunks.entries()) {
      self.postMessage({ type: "progress", status: `Narrating section ${index + 1} of ${plan.chunks.length}…`, completed: index, total: plan.chunks.length });
      const audio = await tts.generate(chunk, { voice: data.voice, speed: data.speed });
      parts.push({ audio: audio.audio, sampling_rate: audio.sampling_rate });
      if (parts.reduce((sum, part) => sum + part.audio.length, 0) > 24000 * 600) throw new Error("Narration exceeds the ten-minute audio limit.");
    }
    const result = joinNarrationAudio(parts);
    const wav = wavFromNarration(result);
    self.postMessage({ type: "done", bytes: wav, durationSeconds: result.durationSeconds }, [wav.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error && /limit|supported|speed|selectable|long/i.test(error.message) ? error.message : "The local voice model could not finish. Check network access, browser storage, and available device memory." });
  } finally {
    self.fetch = nativeFetch;
  }
};
