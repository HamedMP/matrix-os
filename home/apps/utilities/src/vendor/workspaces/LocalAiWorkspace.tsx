import { useEffect, useRef, useState } from "react";
import { Copy, Download, Play, RotateCcw, Send, Square, Trash2 } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { LOCAL_AI_MODELS, LOCAL_CHAT_MODEL, prepareLocalAiInput, prepareLocalChatMessages } from "../lib/local-ai.mjs";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

function track(slug: string, action: "start" | "success" | "error" | "copy" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

type LocalResult = { text?: string; label?: string; confidence?: number };
type WorkerMessage = { type: "progress" | "result" | "error"; id: number; status?: string; percent?: number | null; result?: LocalResult; message?: string };
const examples: Record<string, string> = {
  "text-summarizer": "Matrix OS gives each agent a private workspace with files, tools, and a browser. The agent can keep working after the user's laptop closes. When the work is ready, the user can return to review the result and continue the conversation. The workspace can be reached from web and messaging channels.",
  "sentiment-analysis": "The onboarding was clear and the team responded quickly. I would recommend this product.",
};

export function LocalAiWorkspace({ slug }: { slug: string }) {
  return slug === "local-ai-chat" ? <LocalChatWorkspace /> : <LocalAiTaskWorkspace slug={slug} />;
}

function LocalAiTaskWorkspace({ slug }: { slug: string }) {
  const model = LOCAL_AI_MODELS[slug as keyof typeof LOCAL_AI_MODELS];
  const [input, setInput] = useState(examples[slug] ?? "");
  const [result, setResult] = useState<LocalResult | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    return () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); workerRef.current?.terminate(); workerRef.current = null; };
  }, []);

  function cancel() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    workerRef.current?.terminate(); workerRef.current = null;
    requestRef.current++;
    setBusy(false); setProgress("");
  }

  function run() {
    track(slug, "start");
    setError(""); setResult(null);
    try { prepareLocalAiInput(slug, input); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Enter valid text."); track(slug, "error", cause); return; }
    const id = ++requestRef.current;
    let worker = workerRef.current;
    try {
      worker ??= new Worker(new URL("../lib/local-ai-worker.mjs", import.meta.url), { type: "module" });
      workerRef.current = worker;
    } catch (cause) { setError("This browser could not start a local model worker."); track(slug, "error", cause); return; }
    setBusy(true); setProgress("Preparing local model…");
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.id !== id || id !== requestRef.current) return;
      if (data.type === "progress") {
        setProgress(`${data.status ?? "Loading model"}${typeof data.percent === "number" ? ` ${data.percent}%` : ""}…`);
        return;
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      requestRef.current++;
      setBusy(false); setProgress("");
      if (data.type === "error") { setError(data.message ?? "The local model could not finish this request."); track(slug, "error", new Error("Model worker failed.")); return; }
      const output = data.result ?? null;
      if (!output) { setError("The local model returned no result."); track(slug, "error", new Error("Model worker returned no result.")); return; }
      setResult(output); track(slug, "success");
    };
    worker.onerror = () => { if (id !== requestRef.current) return; cancel(); setError("This browser could not run the local model worker."); track(slug, "error", new Error("Model worker failed.")); };
    timerRef.current = window.setTimeout(() => { if (id !== requestRef.current) return; cancel(); setError("The model took too long. Its first download may need a faster connection or more device memory."); track(slug, "error", new Error("Model timeout.")); }, 240_000);
    try { worker.postMessage({ type: "run", id, slug, text: input }); }
    catch (cause) { cancel(); setError("This browser could not run the local model worker."); track(slug, "error", cause); }
  }

  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.text ?? `${result.label} (${result.confidence}% model confidence)`); track(slug, "copy"); }
    catch (cause) { setError("Automatic copy failed. Select and copy the result instead."); track(slug, "error", cause); }
  }
  function download() {
    if (!result) return;
    const content = result.text ?? `${result.label} (${result.confidence}% model confidence)`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${slug}.txt`; link.click();
    track(slug, "download");
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!model) return <p role="alert">This local AI tool is unavailable.</p>;
  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <label htmlFor="local-ai-input" className="block text-base font-semibold">{slug === "text-summarizer" ? "Passage to summarize" : "Text to assess"}</label>
      <textarea id="local-ai-input" value={input} onChange={(event) => setInput(event.target.value)} maxLength={model.maxInputChars} spellCheck={true} className="mt-3 min-h-60 w-full min-w-0 resize-y rounded-2xl border p-4 text-sm leading-6 outline-none focus:ring-2" style={{ borderColor: `${c.deep}25`, color: c.deep }} />
      <p className="mt-2 text-xs" style={{ color: `${c.deep}B8` }}>{input.length.toLocaleString()} / {model.maxInputChars.toLocaleString()} characters</p>
      <p className="mt-4 text-sm leading-6" style={{ color: `${c.deep}B8` }}>First use downloads approximately {model.downloadMb} MB of model files to this browser and may take several minutes. Your text stays on this device. The model runs on your device&apos;s CPU.</p>
      <p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}B8` }}>This small model works best with English text. {slug === "sentiment-analysis" ? "It judges overall positive or negative tone; sarcasm and mixed opinions may be missed." : "It may omit details or change wording; check the original before sharing."}</p>
      <div className="mt-6 flex flex-wrap gap-2"><button data-utilities-dirty="true" type="button" onClick={run} disabled={busy || !input.trim()} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><Play className="size-4" />{busy ? "Working…" : "Run local model"}</button>{busy && <button type="button" onClick={cancel} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}><Square className="size-4" /> Cancel</button>}{!busy && <button data-utilities-dirty="true" type="button" onClick={() => { setInput(examples[slug] ?? ""); setResult(null); setError(""); }} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}><RotateCcw className="size-4" /> Reset</button>}</div>
      {progress && <p role="status" className="mt-4 text-sm" style={{ color: c.deep }}>{progress}</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p>}
    </div>
    <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">Model result</h2>{result && <div className="flex gap-2"><button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-full border border-white/25 px-3 py-1.5 text-xs"><Copy className="size-3.5" /> Copy</button><button type="button" onClick={download} className="inline-flex items-center gap-1 rounded-full border border-white/25 px-3 py-1.5 text-xs"><Download className="size-3.5" /> Download</button></div>}</div>
      {result ? <div className="mt-6" aria-live="polite">{result.text ? <p className="whitespace-pre-wrap break-words text-base leading-7">{result.text}</p> : <><p className="text-3xl font-semibold">{result.label}</p><p className="mt-3 text-sm text-white/75">{result.confidence}% model confidence for this label</p></>}<p className="mt-7 text-xs leading-5 text-white/60">Local model output can be wrong. Review factual claims and decisions before use.</p></div> : <div className="mt-5 flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/60">{busy ? "The browser is preparing and running the model." : "Your local result will appear here."}</div>}
    </div>
  </div>;
}

type ChatMessage = { role: "user" | "assistant"; content: string };
const chatSuggestions = ["Give me three ideas for a team lunch", "Explain what a QR code is", "Help me write a friendly thank-you note"];

function LocalChatWorkspace() {
  const slug = "local-ai-chat";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const pendingRef = useRef<{ history: ChatMessage[]; draft: string } | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  function stop(restoreDraft = true) {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    requestRef.current++;
    if (pendingRef.current) {
      setMessages(pendingRef.current.history);
      if (restoreDraft) setDraft(pendingRef.current.draft);
      pendingRef.current = null;
    }
    setBusy(false);
    setProgress("");
  }

  function send(value = draft) {
    track(slug, "start");
    setError("");
    const prompt = value.trim();
    try { prepareLocalChatMessages(messages, prompt); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a shorter message.");
      track(slug, "error", cause);
      return;
    }
    let worker = workerRef.current;
    try {
      worker ??= new Worker(new URL("../lib/local-ai-worker.mjs", import.meta.url), { type: "module" });
      workerRef.current = worker;
    } catch (cause) {
      setError("This browser could not start a local model worker.");
      track(slug, "error", cause);
      return;
    }
    const id = ++requestRef.current;
    const history = messages;
    pendingRef.current = { history, draft: prompt };
    setMessages([...history, { role: "user", content: prompt }]);
    setDraft("");
    setBusy(true);
    setProgress("Preparing local model…");
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (id !== requestRef.current || data.id !== id) return;
      if (data.type === "progress") {
        setProgress(`${data.status ?? "Loading model"}${typeof data.percent === "number" ? ` ${data.percent}%` : ""}…`);
        return;
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setBusy(false);
      setProgress("");
      if (data.type === "error" || !data.result?.text) {
        stop();
        setError(data.message ?? "The local model could not finish this reply.");
        track(slug, "error", new Error("Model worker failed."));
        return;
      }
      pendingRef.current = null;
      setMessages([...history, { role: "user" as const, content: prompt }, { role: "assistant" as const, content: data.result.text }].slice(-12));
      track(slug, "success");
    };
    worker.onerror = () => {
      if (id !== requestRef.current) return;
      stop();
      setError("This browser could not run the local model. Check your connection and available memory.");
      track(slug, "error", new Error("Model worker failed."));
    };
    timerRef.current = window.setTimeout(() => {
      if (id !== requestRef.current) return;
      stop();
      setError("The model took too long. Try again on a faster connection or device.");
      track(slug, "error", new Error("Model timeout."));
    }, LOCAL_CHAT_MODEL.timeoutMs);
    try { worker.postMessage({ type: "run", id, slug, history, text: prompt }); }
    catch (cause) {
      stop();
      setError("This browser could not run the local model.");
      track(slug, "error", cause);
    }
  }

  async function copyReply(content: string) {
    try { await navigator.clipboard.writeText(content); track(slug, "copy"); }
    catch (cause) { setError("Automatic copy failed. Select and copy the reply instead."); track(slug, "error", cause); }
  }

  function downloadConversation() {
    if (!messages.length) return;
    try {
      const content = messages.map((message) => `${message.role === "user" ? "You" : "Local model"}: ${message.content}`).join("\n\n");
      const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = "local-chat.txt"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      track(slug, "download");
    } catch (cause) {
      setError("The conversation could not be saved. Try copying the replies instead.");
      track(slug, "error", cause);
    }
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,25rem)]">
    <div className="flex min-w-0 flex-col overflow-hidden rounded-3xl border bg-white" style={{ borderColor: `${c.deep}25` }}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4 sm:px-7" style={{ borderColor: `${c.deep}16` }}>
        <div><h2 className="text-base font-semibold" style={{ color: c.deep }}>Private chat</h2><p className="text-xs" style={{ color: `${c.deep}B8` }}>This conversation exists only in this tab.</p></div>
        <div className="flex gap-2">
          <button type="button" onClick={downloadConversation} disabled={!messages.length || busy} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-medium disabled:opacity-40" style={{ borderColor: `${c.deep}30`, color: c.deep }}><Download className="size-3.5" /> Save</button>
          <button data-utilities-dirty="true" type="button" onClick={() => { stop(false); setMessages([]); setDraft(""); setError(""); }} disabled={!messages.length && !busy} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-medium disabled:opacity-40" style={{ borderColor: `${c.deep}30`, color: c.deep }}><Trash2 className="size-3.5" /> Clear</button>
        </div>
      </div>
      <div className="flex min-h-72 flex-1 flex-col gap-4 p-5 sm:min-h-96 sm:p-7" aria-live="polite">
        {messages.length ? messages.map((message, index) => <div key={index} className={`max-w-[90%] min-w-0 rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "self-end" : "self-start"}`} style={message.role === "user" ? { background: c.deep, color: "white" } : { background: `${c.deep}0D`, color: c.deep }}>
          <p className="mb-1 text-[11px] font-semibold opacity-60">{message.role === "user" ? "You" : "Local model"}</p>
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
          {message.role === "assistant" && <button type="button" onClick={() => void copyReply(message.content)} className="mt-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"><Copy className="size-3" /> Copy reply</button>}
        </div>) : <div className="my-auto text-center"><p className="text-lg font-semibold" style={{ color: c.deep }}>Ask something small</p><p className="mx-auto mt-2 max-w-sm text-sm leading-6" style={{ color: `${c.deep}B8` }}>A compact model can help with simple ideas and short drafts. It cannot browse the web or access your Matrix workspace.</p><div className="mt-5 flex flex-wrap justify-center gap-2">{chatSuggestions.map((suggestion) => <button data-utilities-dirty="true" key={suggestion} type="button" onClick={() => setDraft(suggestion)} className="rounded-full border px-3 py-2 text-xs" style={{ borderColor: `${c.deep}30`, color: c.deep }}>{suggestion}</button>)}</div></div>}
        {busy && <p className="self-start rounded-2xl px-4 py-3 text-sm" style={{ background: `${c.deep}0D`, color: c.deep }}>{progress || "Thinking locally…"}</p>}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) send(); }} className="border-t p-4 sm:p-5" style={{ borderColor: `${c.deep}16` }}>
        <label htmlFor="local-chat-input" className="sr-only">Message for the local model</label>
        <textarea id="local-chat-input" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={LOCAL_CHAT_MODEL.maxInputChars} disabled={busy} rows={3} placeholder="Write a short message…" className="w-full min-w-0 resize-y rounded-2xl border p-3 text-sm outline-none focus:ring-2 disabled:opacity-60" style={{ borderColor: `${c.deep}25`, color: c.deep }} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs" style={{ color: `${c.deep}B8` }}>{draft.length}/{LOCAL_CHAT_MODEL.maxInputChars} characters</span><div className="flex gap-2">{busy && <button type="button" onClick={() => stop()} className="inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm" style={{ borderColor: `${c.deep}30`, color: c.deep }}><Square className="size-3.5" /> Cancel</button>}<button data-utilities-dirty="true" type="submit" disabled={busy || !draft.trim()} className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><Send className="size-3.5" /> Send</button></div></div>
        {error && <p role="alert" className="mt-3 rounded-xl bg-red-100 p-3 text-sm text-red-950">{error}</p>}
      </form>
    </div>
    <aside className="min-w-0 rounded-3xl border p-5 sm:p-7" style={{ borderColor: `${c.deep}25`, color: c.deep }}>
      <h2 className="text-base font-semibold">Runs in your browser</h2>
      <p className="mt-3 text-sm leading-6" style={{ color: `${c.deep}B8` }}>The first use downloads about {LOCAL_CHAT_MODEL.downloadMb} MB of model files. Replies run on your device&apos;s CPU, and may be slow on phones or older computers. Your messages are not sent to Matrix or the model host.</p>
      <p className="mt-4 text-sm leading-6" style={{ color: `${c.deep}B8` }}>The six latest exchanges stay visible, and only the latest three are sent to the model. The conversation disappears when you close or reload this tab. Clear also releases its model from memory.</p>
      <p className="mt-4 text-sm leading-6" style={{ color: `${c.deep}B8` }}>This 135 million parameter English model can make mistakes or repeat itself. Verify important answers. It has no live information.</p>
      <a href="https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct" target="_blank" rel="noopener noreferrer" className="mt-5 inline-block text-xs underline underline-offset-2">SmolLM2 model and Apache 2.0 license</a>
    </aside>
  </div>;
}
