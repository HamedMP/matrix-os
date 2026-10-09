import { env, pipeline } from "@huggingface/transformers";
import { LOCAL_AI_MODELS, LOCAL_CHAT_MODEL, normalizeModelProgress, prepareLocalAiInput, prepareLocalAiOutput, prepareLocalChatMessages, prepareLocalChatOutput } from "./local-ai.mjs";
import { reportToolFailure } from "./diagnostics.mjs";

env.backends.onnx.wasm.numThreads = 1;

let activeSlug = null;
let activePipeline = null;
let busy = false;

self.addEventListener("message", async ({ data }) => {
  if (busy || data?.type !== "run" || !Number.isSafeInteger(data.id) ||
    !(data.slug === "local-ai-chat" || Object.hasOwn(LOCAL_AI_MODELS, data.slug))) return;
  busy = true;
  const { slug, id } = data;
  const isChat = slug === "local-ai-chat";
  const model = isChat ? LOCAL_CHAT_MODEL : LOCAL_AI_MODELS[slug];
  try {
    const prepared = isChat ? prepareLocalChatMessages(data.history, data.text) : prepareLocalAiInput(slug, data.text);
    if (activeSlug !== slug || !activePipeline) {
      if (activePipeline?.dispose) await activePipeline.dispose();
      activeSlug = slug;
      activePipeline = null;
      self.postMessage({ type: "progress", id, status: "Loading model", percent: null });
      activePipeline = await pipeline(model.task, model.id, {
        device: model.device,
        dtype: model.dtype,
        progress_callback: (event) => {
          const progress = normalizeModelProgress(event);
          if (progress) self.postMessage({ type: "progress", id, ...progress });
        },
      });
    }
    self.postMessage({ type: "progress", id, status: "Running model", percent: null });
    const raw = isChat
      ? await activePipeline(prepared, { max_new_tokens: model.maxNewTokens, do_sample: false })
      : slug === "sentiment-analysis"
      ? await activePipeline(prepared.text, { truncation: true, max_length: 512 })
      : await activePipeline(prepared.text, { max_new_tokens: 80, num_beams: 2, do_sample: false });
    self.postMessage({ type: "result", id, result: isChat ? { text: prepareLocalChatOutput(raw) } : prepareLocalAiOutput(slug, raw) });
  } catch (error) {
    reportToolFailure(error);
    self.postMessage({ type: "error", id, message: "This browser could not load or run the local model. Check your connection, storage, and browser support." });
  } finally { busy = false; }
});
