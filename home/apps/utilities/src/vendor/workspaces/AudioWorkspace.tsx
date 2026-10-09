import { reportToolFailure } from "../lib/diagnostics.mjs";

import { useEffect, useRef, useState } from "react";
import { Download, FilePlus2, RotateCcw, Trash2, WandSparkles, X } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";
import { MAX_AUDIO_FILE_BYTES, MAX_AUDIO_SECONDS, MAX_AUDIO_SESSION_BYTES, MAX_AUDIO_SESSION_FILES, MAX_TRANSCRIPTION_FILE_BYTES, MAX_TRANSCRIPTION_SECONDS, assertAudio, assertSpeechAudio, defaultAudioOptions, formatTimestamp, inspectSpeechWavHeader, notesToSrt, patchAudioSessionEntry, planAudioSessionFiles, planAudioSessionSamples, speechExportContent } from "../lib/audio-tools.mjs";
import { clearAudioSession, deleteAudioSessionFile, readAudioSession, saveAudioSessionFile, saveAudioSessionManifest } from "../lib/audio-session.mjs";

type LocalAudio = { sampleRate: number; channels: Float32Array[] };
type AudioResult = { blob: Blob; filename: string; details: string };
type Note = { seconds: number; text: string };
type AudioOptions = { start: number; end: number; denoise: boolean; noiseSeconds: number; strength: number; dynamics: boolean; thresholdDb: number; ratio: number; speed: number; semitones: number };

function track(slug: string, action: "start" | "success" | "error" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

function compressedMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"].find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

function processInWorker(audio: LocalAudio, slug: string, options: AudioOptions): Promise<{ audio: LocalAudio; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../lib/audio-worker.mjs", import.meta.url), { type: "module" });
    const timeout = window.setTimeout(() => finish(new Error("Processing took too long. Try a shorter audio file.")), 90_000);
    function finish(error?: Error, result?: { audio: LocalAudio; bytes: Uint8Array }) {
      window.clearTimeout(timeout); worker.terminate();
      if (error) reject(error); else if (result) resolve(result);
    }
    worker.onerror = () => finish(new Error("Audio processing could not start in this browser."));
    worker.onmessage = (event) => event.data.ok ? finish(undefined, event.data) : finish(new Error(event.data.message));
    worker.postMessage({ audio, slug, options });
  });
}

async function encodeCompressed(audio: LocalAudio, mime: string, bitrate: number): Promise<Blob> {
  const context = new AudioContext({ sampleRate: audio.sampleRate });
  try {
    const buffer = context.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate);
    audio.channels.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index));
    const destination = context.createMediaStreamDestination(), source = context.createBufferSource();
    source.buffer = buffer; source.connect(destination);
    const recorder = new MediaRecorder(destination.stream, { mimeType: mime, audioBitsPerSecond: bitrate });
    const chunks: BlobPart[] = [];
    const result = new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => { recorder.stop(); reject(new Error("Compressed export timed out.")); }, (buffer.duration + 10) * 1000);
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { window.clearTimeout(timeout); reject(new Error("This browser could not encode the audio.")); };
      recorder.onstop = () => { window.clearTimeout(timeout); resolve(new Blob(chunks, { type: mime })); };
      source.onended = () => window.setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 250);
    });
    recorder.start(1000); source.start();
    const blob = await result;
    if (!blob.size) throw new Error("This browser produced an empty audio file.");
    return blob;
  } finally { await context.close(); }
}

function Waveform({ audio, start, end, onSeek }: { audio: LocalAudio; start?: number; end?: number; onSeek?: (seconds: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, context = element?.getContext("2d");
    if (!element || !context) return;
    const width = element.width, height = element.height, samples = audio.channels[0], duration = samples.length / audio.sampleRate;
    context.clearRect(0, 0, width, height); context.fillStyle = "#eff0e9"; context.fillRect(0, 0, width, height);
    if (start !== undefined && end !== undefined) { context.fillStyle = "#dce8d9"; context.fillRect(start / duration * width, 0, (end - start) / duration * width, height); }
    context.fillStyle = c.deep;
    for (let x = 0; x < width; x++) {
      const first = Math.floor(x / width * samples.length), last = Math.max(first + 1, Math.floor((x + 1) / width * samples.length));
      let low = 1, high = -1;
      for (let i = first; i < last; i++) { low = Math.min(low, samples[i]); high = Math.max(high, samples[i]); }
      const top = height / 2 - high * height * .42, bottom = height / 2 - low * height * .42;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [audio, start, end]);
  return <canvas ref={canvas} width={900} height={140} className={`block h-36 w-full rounded-2xl ${onSeek ? "cursor-pointer" : ""}`} role="img" aria-label="Audio waveform" onClick={onSeek ? (event) => { const rect = event.currentTarget.getBoundingClientRect(); onSeek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * audio.channels[0].length / audio.sampleRate); } : undefined} />;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function checkSpeechDuration(file: File) {
  const header = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  const wavDuration = inspectSpeechWavHeader(header, file.size);
  if (wavDuration !== null) {
    if (wavDuration > MAX_TRANSCRIPTION_SECONDS) throw new Error("Speech transcription accepts audio up to two minutes.");
    return;
  }
  const url = URL.createObjectURL(file);
  const preview = document.createElement("audio");
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Could not read audio duration. Try a WAV or MP3 file.")), 15_000);
      const finish = (error?: Error) => {
        window.clearTimeout(timeout);
        preview.onloadedmetadata = null;
        preview.onerror = null;
        if (error) reject(error); else resolve();
      };
      preview.onloadedmetadata = () => finish();
      preview.onerror = () => finish(new Error("This browser could not open the audio file."));
      preview.preload = "metadata";
      preview.src = url;
    });
    if (Number.isFinite(preview.duration) && preview.duration > MAX_TRANSCRIPTION_SECONDS) {
      throw new Error("Speech transcription accepts audio up to two minutes.");
    }
  } finally {
    preview.removeAttribute("src");
    preview.load();
    URL.revokeObjectURL(url);
  }
}

function SingleAudioWorkspace({ slug }: { slug: string }) {
  const [file, setFile] = useState<File | null>(null), [audio, setAudio] = useState<LocalAudio | null>(null);
  const [inputUrl, setInputUrl] = useState(""), [outputUrl, setOutputUrl] = useState("");
  const [result, setResult] = useState<AudioResult | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [start, setStart] = useState(0), [end, setEnd] = useState(0), [noiseSeconds, setNoiseSeconds] = useState(.5), [strength, setStrength] = useState(.75);
  const [denoise, setDenoise] = useState(false), [dynamics, setDynamics] = useState(false), [thresholdDb, setThresholdDb] = useState(-18), [ratio, setRatio] = useState(4);
  const [speed, setSpeed] = useState(1), [semitones, setSemitones] = useState(0), [format, setFormat] = useState("wav"), [bitrate, setBitrate] = useState(64);
  const [notes, setNotes] = useState<Note[]>([]), [draft, setDraft] = useState("");
  const [transcript, setTranscript] = useState(""), [speechStatus, setSpeechStatus] = useState(""), [speechProgress, setSpeechProgress] = useState(0);
  const [nativePlaybackError, setNativePlaybackError] = useState(false), [fallbackPlaying, setFallbackPlaying] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const speechWorker = useRef<Worker | null>(null);
  const cancelSpeech = useRef<(() => void) | null>(null);
  const fallbackPlayback = useRef<{ context: AudioContext; source: AudioBufferSourceNode } | null>(null);
  const duration = audio ? audio.channels[0].length / audio.sampleRate : 0;
  const isNotes = slug === "transcription-player";
  const isSpeech = slug === "speech-to-text";
  const isTrim = slug === "audio-trimmer" || slug === "audio-workspace";
  const isNoise = slug === "noise-reducer" || slug === "audio-workspace";
  const isPitch = slug === "pitch-and-speed" || slug === "audio-workspace";
  const isCompressed = slug === "audio-compressor" || (slug === "audio-converter" && format === "opus");
  const mime = compressedMime();
  useEffect(() => () => { if (inputUrl) URL.revokeObjectURL(inputUrl); }, [inputUrl]);
  useEffect(() => () => { if (outputUrl) URL.revokeObjectURL(outputUrl); }, [outputUrl]);
  useEffect(() => () => { cancelSpeech.current?.(); speechWorker.current?.terminate(); }, []);
  useEffect(() => () => { const playback = fallbackPlayback.current; if (playback) { playback.source.onended = null; playback.source.stop(); void playback.context.close(); } }, []);

  function stopFallbackPlayback() {
    const playback = fallbackPlayback.current;
    fallbackPlayback.current = null;
    if (playback) { playback.source.onended = null; playback.source.stop(); void playback.context.close(); }
    setFallbackPlaying(false);
  }

  async function toggleFallbackPlayback() {
    if (fallbackPlayback.current) { stopFallbackPlayback(); return; }
    if (!audio) return;
    const context = new AudioContext();
    try {
      const buffer = context.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate);
      audio.channels.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index));
      const source = context.createBufferSource();
      source.buffer = buffer; source.connect(context.destination);
      source.onended = () => { fallbackPlayback.current = null; setFallbackPlaying(false); void context.close(); };
      await context.resume();
      source.start();
      fallbackPlayback.current = { context, source };
      setFallbackPlaying(true);
    } catch (cause) { reportToolFailure(cause);
      await context.close();
      setError("This browser could not play the recording. You can still transcribe it locally.");
    }
  }

  async function loadFile(nextFile?: File) {
    stopFallbackPlayback(); setNativePlaybackError(false);
    setFile(null); setAudio(null); setResult(null); setError(""); setNotes([]); setTranscript(""); setStart(0); setEnd(0);
    if (!nextFile) return;
    if (nextFile.size > (isSpeech ? MAX_TRANSCRIPTION_FILE_BYTES : MAX_AUDIO_FILE_BYTES)) {
      setError(isSpeech ? "Choose a recording smaller than 25 MB." : "Choose an audio file smaller than 80 MB."); return;
    }
    setBusy(true);
    let context: AudioContext | null = null;
    try {
      if (typeof AudioContext === "undefined") throw new Error("This browser does not support local audio decoding.");
      if (isSpeech) await checkSpeechDuration(nextFile);
      context = new AudioContext();
      const decoded = await context.decodeAudioData(await nextFile.arrayBuffer());
      if (decoded.numberOfChannels > 2) throw new Error("Choose mono or stereo audio. Multichannel audio is not supported.");
      const local = { sampleRate: decoded.sampleRate, channels: Array.from({ length: decoded.numberOfChannels }, (_, index) => new Float32Array(decoded.getChannelData(index))) };
      assertAudio(local);
      if (isSpeech) assertSpeechAudio(local);
      setFile(nextFile); setAudio(local); setEnd(decoded.duration); setNoiseSeconds(Math.min(.5, decoded.duration / 4));
      setInputUrl(URL.createObjectURL(nextFile));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This browser could not open the audio file."); }
    finally { if (context) await context.close(); setBusy(false); }
  }

  async function run() {
    if (!audio || !file) return;
    setBusy(true); setError(""); setResult(null); track(slug, "start");
    try {
      if (isSpeech) {
        setTranscript(""); setNotes([]); setSpeechProgress(0); setSpeechStatus("Preparing local audio…");
        const output = await new Promise<{ text: string; chunks: Note[] }>((resolve, reject) => {
          const worker = new Worker(new URL("../lib/speech-worker.mjs", import.meta.url), { type: "module" });
          speechWorker.current = worker;
          let settled = false;
          const timeout = window.setTimeout(() => finish(new Error("Local transcription timed out. Try a shorter recording.")), 360_000);
          function finish(error?: Error, result?: { text: string; chunks: Note[] }) {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout); worker.terminate();
            if (speechWorker.current === worker) speechWorker.current = null;
            cancelSpeech.current = null;
            if (error) reject(error); else if (result) resolve(result);
          }
          cancelSpeech.current = () => finish(new DOMException("Transcription cancelled.", "AbortError"));
          worker.onerror = () => finish(new Error("This browser could not start the local transcription model."));
          worker.onmessage = (event) => {
            if (settled) return;
            if (event.data.type === "status") setSpeechStatus(event.data.message);
            else if (event.data.type === "progress") setSpeechProgress(event.data.percent);
            else if (event.data.type === "error") finish(new Error(event.data.message));
            else if (event.data.type === "done") finish(undefined, { text: event.data.text, chunks: event.data.chunks });
          };
          worker.postMessage({ audio });
        });
        if (!output.text) throw new Error("No speech was detected. Try a clearer recording.");
        setTranscript(output.text); setNotes(output.chunks); setSpeechStatus(""); track(slug, "success");
        return;
      }
      const options = { start, end, denoise: slug === "noise-reducer" || denoise, noiseSeconds, strength, dynamics, thresholdDb, ratio, speed, semitones };
      const processed = await processInWorker(audio, slug, options);
      let blob: Blob, extension: string, details: string;
      if (isCompressed) {
        if (!mime) throw new Error("Compressed Opus export is unavailable in this browser. Use WAV export where available.");
        blob = await encodeCompressed(processed.audio, mime, bitrate * 1000);
        extension = mime.startsWith("audio/ogg") ? "ogg" : "webm";
        details = `Opus audio · ${bitrate} kbps target · ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
      } else {
        blob = new Blob([new Uint8Array(processed.bytes)], { type: "audio/wav" }); extension = "wav";
        details = `16-bit PCM WAV · ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
      }
      const base = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "audio";
      setResult({ blob, filename: `${base}-${slug}.${extension}`, details });
      setOutputUrl(URL.createObjectURL(blob)); track(slug, "success");
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Could not process this audio."); track(slug, "error", cause);
      }
    }
    finally { setBusy(false); setSpeechStatus(""); }
  }

  function addNote() {
    if (!draft.trim() || !audio) return;
    track(slug, "start");
    const seconds = Math.min(Math.max(0, player.current?.currentTime ?? 0), Math.max(0, duration - .001));
    setNotes((previous) => [...previous, { seconds, text: draft.trim() }].sort((a, b) => a.seconds - b.seconds)); setDraft("");
    track(slug, "success");
  }

  function downloadNotes(type: "txt" | "srt") {
    try {
      const text = isSpeech ? speechExportContent(transcript, notes, duration, type) : type === "srt" ? notesToSrt(notes, duration) : notes.map((note) => `[${formatTimestamp(note.seconds)}] ${note.text}`).join("\n");
      saveBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `${isSpeech ? "speech-transcript" : "transcription-notes"}.${type}`); track(slug, "download");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export notes."); track(slug, "error", cause); }
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <label htmlFor="audio-file" className="mb-3 block text-base font-semibold" style={{ color: c.deep }}>Choose audio</label>
      <input id="audio-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.opus,.flac,.webm" disabled={busy} onChange={(event) => void loadFile(event.target.files?.[0])} className="block w-full min-w-0 rounded-2xl border p-4 text-sm file:mr-4 file:rounded-full file:border-0 file:px-4 file:py-2" style={{ borderColor: `${c.deep}25` }} />
      <p className="mt-2 text-xs leading-5" style={{ color: `${c.deep}99` }}>Mono or stereo, up to {isSpeech ? "25" : "80"} MB and {(isSpeech ? MAX_TRANSCRIPTION_SECONDS : MAX_AUDIO_SECONDS) / 60} minutes. Input formats depend on your browser&apos;s decoder. Files stay on this device.</p>
      {file && audio && <div className="mt-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong className="min-w-0 truncate">{file.name}</strong><span>{formatTimestamp(duration)} · {audio.sampleRate.toLocaleString()} Hz · {audio.channels.length === 1 ? "Mono" : "Stereo"}</span></div>
        <Waveform audio={audio} start={isTrim ? start : undefined} end={isTrim ? end : undefined} onSeek={isNotes ? (seconds) => { if (player.current) player.current.currentTime = seconds; } : undefined} />
        <audio ref={player} src={inputUrl} controls preload="metadata" className="w-full" aria-label="Original audio preview" onError={() => setNativePlaybackError(true)} />
        {isSpeech && nativePlaybackError && <button type="button" onClick={() => void toggleFallbackPlayback()} className="rounded-full border px-4 py-2 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}>{fallbackPlaying ? "Stop decoded audio" : "Play decoded audio"}</button>}
        {isTrim && <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Start (seconds)<input type="number" min="0" max={Math.max(0, end - .01)} step="0.01" value={start} onChange={(event) => setStart(Number(event.target.value))} className="mt-2 w-full rounded-xl border p-3" /></label><label className="text-sm font-medium">End (seconds)<input type="number" min="0.01" max={duration} step="0.01" value={Number(end.toFixed(2))} onChange={(event) => setEnd(Number(event.target.value))} className="mt-2 w-full rounded-xl border p-3" /></label></div>}
        {isNoise && <div className="space-y-3 rounded-2xl p-4" style={{ background: c.pageBg }}>{slug === "audio-workspace" && <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={denoise} onChange={(event) => setDenoise(event.target.checked)} />Reduce steady background noise</label>}<p className="text-xs">Select an opening section with only background noise, then adjust the reduction strength.</p><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Noise sample (seconds)<input type="number" min="0.05" max={Math.max(.05, duration - .01)} step="0.05" value={noiseSeconds} onChange={(event) => setNoiseSeconds(Number(event.target.value))} className="mt-2 w-full rounded-xl border p-3" /></label><label className="text-sm">Reduction strength: {Math.round(strength * 100)}%<input type="range" min="0" max="1" step="0.05" value={strength} onChange={(event) => setStrength(Number(event.target.value))} className="mt-4 w-full" /></label></div></div>}
        {slug === "audio-workspace" && <div className="rounded-2xl p-4" style={{ background: c.pageBg }}><label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={dynamics} onChange={(event) => setDynamics(event.target.checked)} />Even out loud and quiet peaks</label>{dynamics && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm">Threshold: {thresholdDb} dB<input type="range" min="-40" max="-3" value={thresholdDb} onChange={(event) => setThresholdDb(Number(event.target.value))} className="mt-2 w-full" /></label><label className="text-sm">Ratio: {ratio}:1<input type="range" min="1" max="12" value={ratio} onChange={(event) => setRatio(Number(event.target.value))} className="mt-2 w-full" /></label></div>}</div>}
        {isPitch && <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Speed: {speed.toFixed(2)}×<input type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} className="mt-3 w-full" /></label><label className="text-sm font-medium">Pitch: {semitones > 0 ? "+" : ""}{semitones} semitones<input type="range" min="-12" max="12" step="1" value={semitones} onChange={(event) => setSemitones(Number(event.target.value))} className="mt-3 w-full" /></label></div>}
        {slug === "audio-converter" && <label className="block text-sm font-medium">Output format<select value={format} onChange={(event) => setFormat(event.target.value)} className="mt-2 w-full rounded-xl border p-3"><option value="wav">WAV (uncompressed, universal)</option>{mime && <option value="opus">{mime.startsWith("audio/ogg") ? "Ogg" : "WebM"} / Opus (smaller)</option>}</select></label>}
        {(slug === "audio-compressor" || (slug === "audio-converter" && format === "opus")) && <label className="block text-sm font-medium">Target bitrate<select value={bitrate} onChange={(event) => setBitrate(Number(event.target.value))} className="mt-2 w-full rounded-xl border p-3"><option value="48">48 kbps · smallest</option><option value="64">64 kbps · balanced</option><option value="96">96 kbps · higher quality</option><option value="128">128 kbps · best quality</option></select></label>}
        {!isNotes && <div className="flex flex-wrap gap-2"><button data-utilities-dirty="true" type="button" onClick={() => void run()} disabled={busy || (isCompressed && !mime)} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><WandSparkles className="size-4" />{busy ? isSpeech ? "Transcribing…" : isCompressed ? "Encoding in real time…" : "Processing…" : isSpeech ? "Transcribe locally" : "Process audio"}</button>{isSpeech && busy && <button type="button" onClick={() => cancelSpeech.current?.()} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}><X className="size-4" />Cancel transcription</button>}<button data-utilities-dirty="true" type="button" disabled={busy} onClick={() => { setResult(null); setTranscript(""); setError(""); setStart(0); setEnd(duration); setSpeed(1); setSemitones(0); }} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium disabled:opacity-50" style={{ borderColor: `${c.deep}30` }}><RotateCcw className="size-4" />Reset settings</button></div>}
      </div>}
    </div>
    <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}>
      <h2 className="text-base font-semibold">{isNotes ? "Timestamped notes" : isSpeech ? "Transcript" : "Result"}</h2>
      {error && <p role="alert" className="mt-5 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p>}
      {isNotes && audio ? <div className="mt-5 space-y-4"><p className="text-sm text-white/70">Play the recording, pause at a point, then add a note. Click the waveform to seek.</p><label htmlFor="audio-note" className="block text-sm font-medium">Note at {formatTimestamp(player.current?.currentTime ?? 0)}</label><textarea id="audio-note" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} rows={4} className="w-full rounded-xl bg-white p-3 text-sm text-slate-950" placeholder="Type what you hear…" onKeyDown={(event) => { if (event.ctrlKey && event.code === "Space") { event.preventDefault(); if (player.current?.paused) void player.current.play(); else player.current?.pause(); } }} /><button data-utilities-dirty="true" type="button" onClick={addNote} disabled={!draft.trim()} className="rounded-full bg-white px-5 py-3 text-sm font-semibold disabled:opacity-50" style={{ color: c.deep }}>Add note at playhead</button><p className="text-xs text-white/60">Ctrl + Space toggles playback while typing.</p><ol className="max-h-80 space-y-2 overflow-auto">{notes.map((note, index) => <li key={`${note.seconds}-${index}`} className="rounded-xl bg-white/10 p-3 text-sm"><button type="button" onClick={() => { if (player.current) player.current.currentTime = note.seconds; }} className="mr-2 font-semibold underline">{formatTimestamp(note.seconds)}</button>{note.text}<button data-utilities-dirty="true" type="button" onClick={() => setNotes((current) => current.filter((_, i) => i !== index))} className="ml-3 text-xs underline">Remove</button></li>)}</ol>{notes.length > 0 && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => downloadNotes("txt")} className="rounded-full border border-white/25 px-4 py-2 text-sm">Download notes</button><button type="button" onClick={() => downloadNotes("srt")} className="rounded-full border border-white/25 px-4 py-2 text-sm">Download SRT captions</button></div>}</div> : isSpeech && audio ? transcript ? <div className="mt-5 space-y-5"><p className="whitespace-pre-wrap text-base leading-7">{transcript}</p>{notes.length > 0 && <ol className="max-h-64 space-y-2 overflow-auto text-sm text-white/75">{notes.map((note, index) => <li key={`${note.seconds}-${index}`}>{formatTimestamp(note.seconds)} · {note.text}</li>)}</ol>}<div className="flex flex-wrap gap-2"><button type="button" onClick={() => downloadNotes("txt")} className="rounded-full border border-white/25 px-4 py-2 text-sm">Download text</button>{notes.length > 0 && <button type="button" onClick={() => downloadNotes("srt")} className="rounded-full border border-white/25 px-4 py-2 text-sm">Download SRT</button>}</div></div> : <div className="mt-5 flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/60">{busy ? <><p>{speechStatus}</p>{speechProgress > 0 && <p className="mt-2">Model download: {speechProgress}%</p>}</> : "Your local transcript will appear here."}</div> : result ? <div className="mt-6 space-y-5"><p className="text-sm text-white/75">{result.details}</p><audio src={outputUrl} controls className="w-full" aria-label="Processed audio preview" /><button type="button" onClick={() => { saveBlob(result.blob, result.filename); track(slug, "download"); }} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold" style={{ color: c.deep }}><Download className="size-4" />Download audio</button></div> : <div className="mt-5 flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/60">{isNotes ? "Your notes will appear here after you choose audio." : "Your processed audio will be ready to preview and download here."}</div>}
      {isSpeech && <p className="mt-5 text-xs leading-5 text-white/60">English-only Whisper Tiny runs in this browser. First use downloads model files (up to 150 MB) and stores them in browser cache. Speed and accuracy depend on your device. Your recording is never uploaded.</p>}
      {slug === "noise-reducer" && <p className="mt-5 text-xs leading-5 text-white/60">Best for steady hiss or hum. A clean noise sample at the start improves results; speech or music in that sample can also be reduced.</p>}
      {slug === "pitch-and-speed" && <p className="mt-5 text-xs leading-5 text-white/60">Independent pitch and speed processing can introduce artifacts on complex music. Preview the result before sharing.</p>}
      {isCompressed && <p className="mt-5 text-xs leading-5 text-white/60">Compressed encoding plays the file in real time. Opus output requires browser support and may not play in every app.</p>}
    </div>
  </div>;
}

type SessionItem = {
  id: string; file: File; audio: LocalAudio; options: AudioOptions;
  inputUrl: string; result?: AudioResult; outputUrl?: string;
};

async function decodeSessionFile(file: File): Promise<LocalAudio> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) throw new Error("Choose mono or stereo audio.");
    const audio = { sampleRate: decoded.sampleRate, channels: Array.from({ length: decoded.numberOfChannels }, (_, i) => new Float32Array(decoded.getChannelData(i))) };
    assertAudio(audio);
    return audio;
  } finally { await context.close(); }
}

function AudioSessionWorkspace() {
  const [items, setItems] = useState<SessionItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [persistent, setPersistent] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [storageMessage, setStorageMessage] = useState("");
  const urls = useRef(new Set<string>());
  const active = items.find((item) => item.id === activeId) ?? null;
  const usedBytes = items.reduce((sum, item) => sum + item.file.size, 0);

  function trackUrl(blob: Blob) { const url = URL.createObjectURL(blob); urls.current.add(url); return url; }
  function releaseUrl(url?: string) { if (url && urls.current.delete(url)) URL.revokeObjectURL(url); }

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const session = await readAudioSession();
        const restored: SessionItem[] = [];
        for (const entry of session.entries) {
          const blob = session.files.get(entry.id);
          if (!blob) continue;
          try {
            const file = new File([blob], entry.name, { type: blob.type || "audio/wav" });
            const audio = await decodeSessionFile(file);
            planAudioSessionSamples(restored.map((item) => item.audio), [audio]);
            const inputUrl = trackUrl(file);
            restored.push({ id: entry.id, file, audio, options: entry.options, inputUrl });
          } catch (cause) { reportToolFailure(cause); /* Skip a file the current browser cannot decode. */ }
        }
        if (cancelled) { restored.forEach((item) => releaseUrl(item.inputUrl)); return; }
        setItems(restored);
        setActiveId(restored.some((item) => item.id === session.activeId) ? session.activeId : restored[0]?.id ?? null);
        if (restored.length < session.entries.length) setStorageMessage("Some saved files could not be reopened by this browser. You can remove or clear this session.");
      } catch (cause) { reportToolFailure(cause);
        if (!cancelled) { setPersistent(false); setStorageMessage("Session recovery is unavailable. Your files still work in this tab."); }
      } finally { if (!cancelled) setReady(true); }
    }
    void restore();
    return () => { cancelled = true; for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); };
  }, []);

  useEffect(() => {
    if (!ready || !persistent) return;
    const timer = window.setTimeout(() => {
      const manifest = { activeId, entries: items.map((item) => ({ id: item.id, name: item.file.name, size: item.file.size, duration: item.audio.channels[0].length / item.audio.sampleRate, options: item.options })) };
      void saveAudioSessionManifest(manifest).catch((cause: unknown) => { reportToolFailure(cause); setPersistent(false); setStorageMessage("Browser storage is full or unavailable. This session remains in the current tab only."); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [items, activeId, ready, persistent]);

  async function addFiles(files: File[]) {
    if (!files.length) return;
    setError("");
    try { planAudioSessionFiles(items.map((item) => item.file), files); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "These files exceed the session limit."); return; }
    setBusy(true);
    const added: SessionItem[] = [];
    try {
      for (const file of files) {
        const audio = await decodeSessionFile(file);
        planAudioSessionSamples([...items.map((item) => item.audio), ...added.map((item) => item.audio)], [audio]);
        const id = crypto.randomUUID();
        const inputUrl = trackUrl(file);
        added.push({ id, file, audio, options: defaultAudioOptions(audio.channels[0].length / audio.sampleRate), inputUrl });
      }
      if (persistent) {
        try { for (const item of added) await saveAudioSessionFile(item.id, item.file); }
        catch (cause) { reportToolFailure(cause); setPersistent(false); setStorageMessage("Browser storage is full or unavailable. New files will work only in this tab."); }
      }
      setItems((current) => [...current, ...added]); setActiveId(added[0].id);
    } catch (cause) {
      added.forEach((item) => releaseUrl(item.inputUrl));
      setError(cause instanceof Error ? cause.message : "This browser could not decode one of the audio files.");
    } finally { setBusy(false); }
  }

  function updateOptions(changes: Partial<AudioOptions>) {
    if (!active) return;
    releaseUrl(active.outputUrl);
    setItems((current) => patchAudioSessionEntry(current, active.id, changes).map((item: SessionItem) => item.id === active.id ? { ...item, result: undefined, outputUrl: undefined } : item));
  }

  async function removeItem(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    releaseUrl(item.inputUrl); releaseUrl(item.outputUrl);
    const remaining = items.filter((candidate) => candidate.id !== id);
    setItems(remaining);
    if (activeId === id) setActiveId(remaining[0]?.id ?? null);
    try { await deleteAudioSessionFile(id); }
    catch (cause) { reportToolFailure(cause); setPersistent(false); setStorageMessage("This file was removed from the current tab, but browser storage could not be updated. Clear this site's data in browser settings to erase any saved copy."); }
  }

  async function clearSession() {
    setError("");
    let storageCleared = false;
    try { await clearAudioSession(); storageCleared = true; }
    catch (cause) { reportToolFailure(cause); setPersistent(false); }
    items.forEach((item) => { releaseUrl(item.inputUrl); releaseUrl(item.outputUrl); });
    setItems([]); setActiveId(null);
    if (storageCleared) setPersistent(true);
    setStorageMessage(storageCleared ? "Session cleared from this browser." : "Current tab cleared. Browser storage could not be cleared; erase this site's data in browser settings to remove any saved copy.");
  }

  async function processActive() {
    if (!active) return;
    setError(""); setBusy(true); track("audio-workspace", "start");
    try {
      const selectedSeconds = active.options.end - active.options.start;
      if (active.options.denoise && selectedSeconds <= active.options.noiseSeconds) throw new Error("Choose a longer clip than the noise sample, or shorten the noise sample.");
      const processed = await processInWorker(active.audio, "audio-workspace", active.options);
      const blob = new Blob([new Uint8Array(processed.bytes)], { type: "audio/wav" });
      const filename = `${active.file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "audio"}-edited.wav`;
      const outputUrl = trackUrl(blob);
      releaseUrl(active.outputUrl);
      setItems((current) => current.map((item) => item.id === active.id ? { ...item, result: { blob, filename, details: `16-bit PCM WAV · ${(blob.size / 1024 / 1024).toFixed(2)} MB` }, outputUrl } : item));
      track("audio-workspace", "success");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not process this audio."); track("audio-workspace", "error", cause); }
    finally { setBusy(false); }
  }

  return <div className="min-w-0 space-y-5">
    <div className="rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Your audio session</h2><p className="mt-1 max-w-2xl text-sm leading-6" style={{ color: `${c.deep}99` }}>Work on up to five recordings in separate tabs. Each keeps its own edits. Original files never leave your browser.</p></div><button data-utilities-dirty="true" type="button" onClick={() => void clearSession()} disabled={!ready || busy || !items.length} className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium disabled:opacity-50" style={{ borderColor: `${c.deep}30` }}><Trash2 className="size-4" />Clear session</button></div>
      <div className="mt-5 flex flex-wrap items-center gap-4"><label htmlFor="session-audio-files" aria-disabled={!ready || busy || items.length >= MAX_AUDIO_SESSION_FILES} className={`inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white ${!ready || busy || items.length >= MAX_AUDIO_SESSION_FILES ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`} style={{ background: c.deep }}><FilePlus2 className="size-4" />{items.length >= MAX_AUDIO_SESSION_FILES ? "Session full" : "Add audio files"}</label><input id="session-audio-files" type="file" multiple accept="audio/*,.wav,.mp3,.m4a,.ogg,.opus,.flac,.webm" disabled={!ready || busy || items.length >= MAX_AUDIO_SESSION_FILES} onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} className="sr-only" /><span className="text-xs" style={{ color: `${c.deep}99` }}>{items.length} / {MAX_AUDIO_SESSION_FILES} files · {(usedBytes / 1024 / 1024).toFixed(1)} / {MAX_AUDIO_SESSION_BYTES / 1024 / 1024} MB saved</span></div>
      <p className="mt-3 text-xs leading-5" style={{ color: `${c.deep}99` }}>Each file can be up to 40 MB and three minutes. Session recovery uses this browser&apos;s local storage; clear it here when finished. Input codec support varies by browser.</p>
      {!ready && <p className="mt-4 text-sm">Restoring saved session…</p>}
      {storageMessage && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{storageMessage}</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-100 p-3 text-sm text-red-950">{error}</p>}
    </div>
    {items.length > 0 && <div role="tablist" aria-label="Audio files" className="flex min-w-0 gap-2 overflow-x-auto pb-2">{items.map((item) => <div key={item.id} role="presentation" className="inline-flex max-w-64 shrink-0 items-center rounded-full border bg-white pl-1 pr-1" style={{ borderColor: item.id === activeId ? c.deep : `${c.deep}25` }}><button id={`audio-tab-${item.id}`} type="button" role="tab" aria-selected={item.id === activeId} aria-controls="audio-session-panel" onClick={() => { setActiveId(item.id); setError(""); }} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const index = items.findIndex((candidate) => candidate.id === item.id), next = items[(index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]; setActiveId(next.id); document.getElementById(`audio-tab-${next.id}`)?.focus(); }} className="min-w-0 truncate rounded-full px-4 py-2.5 text-sm font-medium">{item.file.name}</button><button data-utilities-dirty="true" type="button" aria-label={`Remove ${item.file.name}`} onClick={() => void removeItem(item.id)} className="rounded-full p-2 hover:bg-black/5"><X className="size-4" /></button></div>)}</div>}
    {active ? <div id="audio-session-panel" role="tabpanel" aria-labelledby={`audio-tab-${active.id}`} className="grid min-w-0 gap-5 lg:grid-cols-2">
      <div className="min-w-0 space-y-5 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 truncate text-lg font-semibold">{active.file.name}</h3><span className="text-xs" style={{ color: `${c.deep}99` }}>{formatTimestamp(active.audio.channels[0].length / active.audio.sampleRate)} · {active.audio.sampleRate.toLocaleString()} Hz · {active.audio.channels.length === 1 ? "Mono" : "Stereo"}</span></div>
        <Waveform audio={active.audio} start={active.options.start} end={active.options.end} />
        <audio src={active.inputUrl} controls preload="metadata" className="w-full" aria-label={`Original audio for ${active.file.name}`} />
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Start (seconds)<input type="number" min="0" max={Math.max(0, active.options.end - .01)} step="0.01" value={Number(active.options.start.toFixed(2))} onChange={(event) => updateOptions({ start: Math.max(0, Math.min(Number(event.target.value) || 0, active.options.end - .01)) })} className="mt-2 w-full rounded-xl border p-3" /></label><label className="text-sm font-medium">End (seconds)<input type="number" min={active.options.start + .01} max={active.audio.channels[0].length / active.audio.sampleRate} step="0.01" value={Number(active.options.end.toFixed(2))} onChange={(event) => updateOptions({ end: Math.min(active.audio.channels[0].length / active.audio.sampleRate, Math.max(Number(event.target.value) || .01, active.options.start + .01)) })} className="mt-2 w-full rounded-xl border p-3" /></label></div>
        <div className="space-y-3 rounded-2xl p-4" style={{ background: c.pageBg }}><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={active.options.denoise} onChange={(event) => updateOptions({ denoise: event.target.checked })} />Reduce steady background noise</label>{active.options.denoise && <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Opening noise sample (seconds)<input type="number" min="0.05" max={active.options.end - active.options.start} step="0.05" value={active.options.noiseSeconds} onChange={(event) => updateOptions({ noiseSeconds: Math.max(.05, Number(event.target.value) || .05) })} className="mt-2 w-full rounded-xl border p-3" /></label><label className="text-sm">Strength: {Math.round(active.options.strength * 100)}%<input type="range" min="0" max="1" step="0.05" value={active.options.strength} onChange={(event) => updateOptions({ strength: Number(event.target.value) })} className="mt-4 w-full" /></label></div>}<p className="text-xs" style={{ color: `${c.deep}99` }}>Select a clip that begins with noise only. Voices in that sample may be reduced too.</p></div>
        <div className="rounded-2xl p-4" style={{ background: c.pageBg }}><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={active.options.dynamics} onChange={(event) => updateOptions({ dynamics: event.target.checked })} />Even out volume peaks</label>{active.options.dynamics && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm">Threshold: {active.options.thresholdDb} dB<input type="range" min="-40" max="-3" value={active.options.thresholdDb} onChange={(event) => updateOptions({ thresholdDb: Number(event.target.value) })} className="mt-2 w-full" /></label><label className="text-sm">Ratio: {active.options.ratio}:1<input type="range" min="1" max="12" value={active.options.ratio} onChange={(event) => updateOptions({ ratio: Number(event.target.value) })} className="mt-2 w-full" /></label></div>}</div>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Speed: {active.options.speed.toFixed(2)}×<input type="range" min="0.5" max="2" step="0.05" value={active.options.speed} onChange={(event) => updateOptions({ speed: Number(event.target.value) })} className="mt-3 w-full" /></label><label className="text-sm font-medium">Pitch: {active.options.semitones > 0 ? "+" : ""}{active.options.semitones} semitones<input type="range" min="-12" max="12" step="1" value={active.options.semitones} onChange={(event) => updateOptions({ semitones: Number(event.target.value) })} className="mt-3 w-full" /></label></div>
        <button data-utilities-dirty="true" type="button" onClick={() => void processActive()} disabled={busy} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><WandSparkles className="size-4" />{busy ? "Processing…" : "Preview edits"}</button>
      </div>
      <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}><h3 className="text-lg font-semibold">Edited audio</h3>{active.result ? <div className="mt-8 space-y-5"><p className="text-sm text-white/75">{active.result.details}</p><audio src={active.outputUrl} controls className="w-full" aria-label={`Edited audio for ${active.file.name}`} /><button type="button" onClick={() => { saveBlob(active.result!.blob, active.result!.filename); track("audio-workspace", "download"); }} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold" style={{ color: c.deep }}><Download className="size-4" />Download WAV</button></div> : <div className="mt-5 flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/60">Choose settings, then preview this file. Each tab has its own result.</div>}<p className="mt-6 text-xs leading-5 text-white/60">Exports are 16-bit WAV. Reloading restores original files and edit settings; process again to recreate an export.</p></div>
    </div> : ready && <div className="flex min-h-72 items-center justify-center rounded-3xl border border-dashed p-6 text-center text-sm" style={{ borderColor: `${c.deep}40`, color: `${c.deep}99` }}>Add audio files to begin a private, recoverable session.</div>}
  </div>;
}

export function AudioWorkspace({ slug }: { slug: string }) {
  return slug === "audio-workspace" ? <AudioSessionWorkspace /> : <SingleAudioWorkspace slug={slug} />;
}
