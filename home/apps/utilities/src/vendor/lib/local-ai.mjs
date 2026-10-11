/** Fixed browser model choices. Prompt text is never included in telemetry or server requests. */
export const LOCAL_AI_MODELS = Object.freeze({
  "text-summarizer": Object.freeze({ id: "Xenova/flan-t5-small", task: "text2text-generation", dtype: "q8", device: "wasm", downloadMb: 100, maxInputChars: 1600, requiresWebGpu: false }),
  "sentiment-analysis": Object.freeze({ id: "Xenova/distilbert-base-uncased-finetuned-sst-2-english", task: "sentiment-analysis", dtype: "q8", device: "wasm", downloadMb: 70, maxInputChars: 1200, requiresWebGpu: false }),
});

/** Apache-2.0 model: https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct */
export const LOCAL_CHAT_MODEL = Object.freeze({
  id: "HuggingFaceTB/SmolLM2-135M-Instruct",
  task: "text-generation",
  device: "wasm",
  dtype: "q4",
  downloadMb: 185,
  maxInputChars: 600,
  maxNewTokens: 96,
  timeoutMs: 300_000,
});

export function prepareLocalChatMessages(history, prompt) {
  if (!Array.isArray(history) || history.length > 24 || history.some((message) =>
    !message || typeof message !== "object" || !["user", "assistant"].includes(message.role) ||
    typeof message.content !== "string" || !message.content.trim() || message.content.length > LOCAL_CHAT_MODEL.maxInputChars
  )) throw new Error("Invalid chat history.");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Enter a message.");
  if (prompt.length > LOCAL_CHAT_MODEL.maxInputChars) throw new Error("Enter up to 600 characters.");
  return [
    { role: "system", content: "You are a concise, helpful assistant. If unsure, say so. Reply in English." },
    ...history.slice(-6).map(({ role, content }) => ({ role, content: content.trim() })),
    { role: "user", content: prompt.trim() },
  ];
}

export function prepareLocalChatOutput(output) {
  const messages = Array.isArray(output) ? output[0]?.generated_text : null;
  const last = Array.isArray(messages) ? messages.at(-1) : null;
  if (last?.role !== "assistant" || typeof last.content !== "string" || !last.content.trim() || last.content.length > 1200) {
    throw new Error("Unexpected model output.");
  }
  return last.content.trim();
}

export function prepareLocalAiInput(slug, value) {
  const model = LOCAL_AI_MODELS[slug];
  if (!model) throw new Error("Unknown local AI tool.");
  if (typeof value !== "string") throw new Error("Enter text to process.");
  if (value.length > model.maxInputChars) throw new Error(`Enter up to ${model.maxInputChars.toLocaleString("en-US")} characters.`);
  const text = value.trim();
  if (!text) throw new Error("Enter text to process.");
  if (slug === "text-summarizer" && text.length < 80) throw new Error("Enter at least 80 characters to summarize a passage.");
  if (slug === "sentiment-analysis" && text.length < 3) throw new Error("Enter at least three characters to assess sentiment.");
  if (slug === "text-summarizer") return { text: `summarize: ${text}` };
  return { text };
}

export function prepareLocalAiOutput(slug, output) {
  if (!LOCAL_AI_MODELS[slug]) throw new Error("Unknown local AI tool.");
  const first = Array.isArray(output) ? output[0] : output;
  if (!first || typeof first !== "object") throw new Error("Unexpected model output.");
  if (slug === "sentiment-analysis") {
    if (!["POSITIVE", "NEGATIVE"].includes(first.label) || !Number.isFinite(first.score) || first.score < 0 || first.score > 1) throw new Error("Unexpected model output.");
    return { label: first.label === "POSITIVE" ? "Positive" : "Negative", confidence: Math.round(first.score * 100) };
  }
  let text = first.generated_text;
  if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new Error("Unexpected model output.");
  return { text: text.trim() };
}

export function normalizeModelProgress(progress) {
  if (!progress || typeof progress !== "object") return null;
  if (progress.status === "progress" || progress.status === "progress_total") return { status: "Downloading model", percent: Number.isFinite(progress.progress) ? Math.max(0, Math.min(100, Math.round(progress.progress))) : null };
  if (["initiate", "download"].includes(progress.status)) return { status: "Starting model download", percent: null };
  if (["done", "ready"].includes(progress.status)) return { status: "Preparing model", percent: null };
  return null;
}
