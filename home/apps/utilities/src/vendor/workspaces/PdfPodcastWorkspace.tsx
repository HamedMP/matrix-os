import { useEffect, useRef, useState } from "react";
import { Download, FileAudio2, FileText, Play, Square, UploadCloud } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { capturePostHogEvent } from "../runtime/telemetry";
import { toolEvent } from "../lib/telemetry.mjs";
import { buildPdfNarration, PDF_NARRATION_MAX_BYTES, PDF_NARRATION_MAX_CHARS, PDF_NARRATION_MAX_PAGES, PDF_NARRATION_VOICES } from "../lib/pdf-podcast.mjs";

type WorkerEvent = { type: "progress" | "done" | "error"; status?: string; completed?: number; total?: number; message?: string; bytes?: Uint8Array; durationSeconds?: number };

function track(action: "start" | "success" | "error" | "download", error?: unknown) {
  const event = toolEvent("pdf-podcast", action, error);
  capturePostHogEvent(event.name, event.properties);
}

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function PdfPodcastWorkspace() {
  const [fileName, setFileName] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(PDF_NARRATION_VOICES[0].id);
  const [speed, setSpeed] = useState(1);
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [working, setWorking] = useState(false);
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const worker = useRef<Worker | null>(null);
  const timer = useRef<number | null>(null);
  const request = useRef(0);

  useEffect(() => () => {
    request.current++;
    worker.current?.terminate();
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  function resetOutput() { setUrl(""); setDuration(0); }

  function stop() {
    request.current++;
    worker.current?.terminate(); worker.current = null;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setWorking(false); setStatus("");
  }

  async function chooseFile(file?: File) {
    stop(); resetOutput(); setError(""); setNotice(""); setText(""); setFileName(""); setPageCount(0);
    if (!file) return;
    const id = ++request.current;
    setReading(true); setStatus("Reading selectable text from this PDF…");
    try {
      if (file.size > PDF_NARRATION_MAX_BYTES) throw new Error("Choose a PDF no larger than 12 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Choose a valid PDF file.");
      const { extractPdfPages } = await import("../lib/pdf-extract.mjs");
      const pages = await extractPdfPages(bytes);
      if (id !== request.current) return;
      if (pages.length > PDF_NARRATION_MAX_PAGES) throw new Error(`Choose a PDF with ${PDF_NARRATION_MAX_PAGES} pages or fewer.`);
      const extracted = pages.map((rows: string[]) => rows.join(" ")).join("\n\n").trim();
      if (!extracted) throw new Error("This PDF has no selectable text. Run OCR first for scanned pages.");
      const preview = extracted.length > PDF_NARRATION_MAX_CHARS ? extracted.slice(0, PDF_NARRATION_MAX_CHARS).replace(/\s+\S*$/, "").trimEnd() : extracted;
      setFileName(file.name); setPageCount(pages.length); setText(preview);
      if (extracted.length > PDF_NARRATION_MAX_CHARS) setNotice("The PDF is longer than this local narration limit. The script below contains only its beginning; review and edit it before generating audio.");
    } catch (cause) {
      if (id === request.current) { setError(cause instanceof Error ? cause.message : "Could not read PDF text."); track("error", cause); }
    } finally {
      if (id === request.current) { setReading(false); setStatus(""); }
    }
  }

  function generate() {
    stop(); resetOutput(); setError("");
    track("start");
    try { buildPdfNarration([[text]]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Edit the script before generating audio."); track("error", cause); return; }
    const id = ++request.current;
    let nextWorker: Worker;
    try { nextWorker = new Worker(new URL("../lib/pdf-podcast.worker.mjs", import.meta.url), { type: "module" }); }
    catch (cause) { setError("This browser could not start the local voice model."); track("error", cause); return; }
    worker.current = nextWorker;
    setWorking(true); setStatus("Preparing the local voice model…");
    const finish = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      nextWorker.terminate();
      if (worker.current === nextWorker) worker.current = null;
      setWorking(false); setStatus("");
    };
    nextWorker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => {
      if (id !== request.current) return;
      if (data.type === "progress") { setStatus(data.status ?? "Generating speech locally…"); return; }
      finish();
      if (data.type === "error") { setError(data.message ?? "Could not generate narration."); track("error", new Error("Local voice model failed.")); return; }
      if (!(data.bytes instanceof Uint8Array) || data.bytes.length <= 44 || !data.durationSeconds) { setError("The voice model returned no usable audio."); track("error", new Error("Empty model output.")); return; }
      setUrl(URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: "audio/wav" })));
      setDuration(data.durationSeconds);
      track("success");
    };
    nextWorker.onerror = () => {
      if (id !== request.current) return;
      finish(); setError("The local voice model could not run in this browser. Try a desktop browser with more free memory."); track("error", new Error("Local voice worker failed."));
    };
    timer.current = window.setTimeout(() => {
      if (id !== request.current) return;
      finish(); setError("Narration took too long. Try a shorter script or a faster connection for the first model download."); track("error", new Error("Local voice timeout."));
    }, 8 * 60_000);
    try { nextWorker.postMessage({ text, voice, speed }); }
    catch (cause) { finish(); setError("This browser could not start narration."); track("error", cause); }
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
    <section className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }} aria-label="PDF narration setup">
      <div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-2xl" style={{ background: `${c.deep}12`, color: c.deep }}><FileText className="size-5" /></span><div><h2 className="text-lg font-semibold" style={{ color: c.deep }}>Make your reading script</h2><p className="mt-1 text-sm" style={{ color: `${c.deep}B8` }}>Your PDF text and audio stay on this device.</p></div></div>
      <label htmlFor="pdf-narration-file" className="mt-6 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-8 text-center transition-colors hover:bg-emerald-50" style={{ borderColor: `${c.deep}48` }}><UploadCloud className="size-7" style={{ color: c.deep }} /><span className="mt-3 text-sm font-semibold" style={{ color: c.deep }}>{fileName || "Choose a text-based PDF"}</span><span className="mt-1 text-xs" style={{ color: `${c.deep}B8` }}>Up to 12 MB and 20 pages</span></label>
      <input id="pdf-narration-file" type="file" accept="application/pdf,.pdf" className="sr-only" disabled={working || reading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void chooseFile(file); }} />
      {pageCount > 0 && <p className="mt-3 text-xs" style={{ color: `${c.deep}B8` }}>{pageCount} {pageCount === 1 ? "page" : "pages"} · {text.length.toLocaleString()} characters selected</p>}
      <label htmlFor="pdf-narration-script" className="mt-6 block text-sm font-semibold" style={{ color: c.deep }}>Edit the narration</label>
      <textarea id="pdf-narration-script" value={text} maxLength={PDF_NARRATION_MAX_CHARS} onChange={(event) => { setText(event.target.value); resetOutput(); }} disabled={reading || working} placeholder="Choose a PDF to extract its text, then correct anything before recording." className="mt-2 min-h-56 w-full resize-y rounded-2xl border p-4 text-sm leading-6 outline-none focus:ring-2 disabled:opacity-60" style={{ borderColor: `${c.deep}30`, color: c.deep }} />
      <p className="mt-1 text-right text-xs" style={{ color: `${c.deep}B8` }}>{text.length.toLocaleString()} / {PDF_NARRATION_MAX_CHARS.toLocaleString()} characters</p>
      {notice && <p role="note" className="mt-3 rounded-xl p-3 text-sm leading-5" style={{ background: `${c.deep}0C`, color: c.deep }}>{notice}</p>}
      <div className="mt-6 grid gap-4 sm:grid-cols-2"><div><label htmlFor="pdf-narration-voice" className="block text-sm font-semibold" style={{ color: c.deep }}>English voice</label><select id="pdf-narration-voice" value={voice} onChange={(event) => { setVoice(event.target.value); resetOutput(); }} disabled={working} className="mt-2 w-full rounded-xl border bg-white px-3 py-3 text-sm" style={{ borderColor: `${c.deep}30`, color: c.deep }}>{PDF_NARRATION_VOICES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div><div><label htmlFor="pdf-narration-speed" className="block text-sm font-semibold" style={{ color: c.deep }}>Speaking speed · {speed.toFixed(1)}×</label><input id="pdf-narration-speed" type="range" min="0.8" max="1.2" step="0.1" value={speed} onChange={(event) => { setSpeed(Number(event.target.value)); resetOutput(); }} disabled={working} className="mt-5 w-full accent-emerald-950" /></div></div>
      <div className="mt-6 flex flex-wrap gap-2"><button type="button" onClick={generate} disabled={!text.trim() || working || reading} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" style={{ background: c.deep }}><Play className="size-4" />{working ? "Creating narration…" : "Create narration"}</button>{working && <button type="button" onClick={stop} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30`, color: c.deep }}><Square className="size-4" /> Cancel</button>}</div>
      {status && <p role="status" className="mt-4 text-sm" style={{ color: c.deep }}>{status}</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p>}
    </section>
    <section className="flex min-w-0 flex-col rounded-3xl p-5 text-white sm:p-7" style={{ background: c.deep }} aria-label="Audio preview">
      <div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-white/15"><FileAudio2 className="size-5" /></span><div><h2 className="text-lg font-semibold">Your narrated audio</h2><p className="mt-1 text-sm text-white/70">Listen, then download a standard WAV file.</p></div></div>
      {url ? <div className="mt-8 rounded-2xl border border-white/20 bg-white/10 p-5"><p className="text-sm font-semibold">Ready to listen · {formatDuration(duration)}</p><audio controls src={url} className="mt-4 w-full" aria-label="PDF narration audio" /><a href={url} download="pdf-narration.wav" onClick={() => track("download")} className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold" style={{ color: c.deep }}><Download className="size-4" /> Download WAV</a></div> : <div className="mt-8 flex min-h-52 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/65">{working ? "The browser is generating spoken audio." : "Your audio preview will appear here."}</div>}
      <div className="mt-auto pt-8 text-sm leading-6 text-white/70"><p>First use downloads about 100 MB of voice files. This can take several minutes and needs free browser storage and memory.</p><p className="mt-3">This is a spoken reading of the edited text. It does not summarize the document or create a conversation. Pronunciation can be imperfect, especially for names and technical terms.</p></div>
    </section>
  </div>;
}
