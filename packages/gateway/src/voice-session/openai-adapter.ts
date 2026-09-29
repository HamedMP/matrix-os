/**
 * OpenAI provider voice media adapter (Layer 4 seam).
 *
 * Chunked provider-neutral path behind the `VoiceMediaAdapter` port:
 * capture frames are buffered per turn, encoded as canonical WAV, and posted
 * to the file-transcription endpoint; canonical segment text is synthesized
 * with the speech endpoint and streamed back as bounded `synthesis.audio`
 * chunks. Provider frames never cross the port — only the shared contract
 * vocabulary (`transcript.final`, `vad`, `synthesis.*`, safe `error` codes).
 *
 * Safety posture mirrors `packages/platform/src/speech/adapters/openai.ts`:
 * bounded reads, `redirect: "error"`, timeout + per-operation abort signals,
 * and no provider names/endpoints/error text in emitted events.
 */
import type { VoiceTurnMode } from "@matrix-os/contracts/voice-session";
import { z } from "zod/v4";
import {
  VoiceAdapterCapabilitiesSchema,
  type VoiceAdapterCapabilities,
  type VoiceAdapterEvent,
  type VoiceAdapterSessionContext,
  type VoiceMediaAdapter,
  type VoiceMediaSession,
  type VoiceSynthesisCommand,
} from "./adapter.js";
import {
  createSystemVoiceClock,
  type VoiceClock,
  type VoiceTimer,
} from "./ports.js";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const TRANSCRIPTION_TIMEOUT_MS = 55_000;
const SPEECH_TIMEOUT_MS = 60_000;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 128 * 1024;
const SYNTH_CHUNK_BYTES = 24 * 1024;
/** 24kHz s16le mono output audio: 24_000 * 2 / 1_000. */
const SYNTH_BYTES_PER_MS = 48;
const MAX_QUEUED_SEGMENTS = 16;
const MAX_SYNTH_RESPONSES = 64;
const MAX_INFLIGHT_TRANSCRIPTIONS = 4;
const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SYNTHESIS_BYTES = 16 * 1024 * 1024;
const DEFAULT_VAD = { silenceThresholdRms: 500, silenceHangoverMs: 900, minSpeechMs: 250 } as const;

const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const VOICE_SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TRANSCRIPT_CHARS = 8_000;

const TranscriptionResponseSchema = z
  .object({ text: z.string().max(MAX_TRANSCRIPT_CHARS) })
  .passthrough();

export interface OpenAiVoiceAdapterOptions {
  apiKey: string;
  /** File-transcription model, e.g. "gpt-4o-mini-transcribe" or "whisper-1". */
  transcriptionModel: string;
  /** Speech model, e.g. "gpt-4o-mini-tts". */
  speechModel: string;
  /** Speech voice, e.g. "alloy". */
  voice: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Schedules VAD hangover; tests inject a fake clock. */
  clock?: VoiceClock;
  id?: string;
  capabilities?: Partial<VoiceAdapterCapabilities>;
  /** Capture buffer cap in decoded PCM bytes (default ~8 MiB). */
  maxCaptureBytes?: number;
  /** Synthesis stream cap in bytes (default ~16 MiB). */
  maxSynthesisBytes?: number;
  /** Server-side energy VAD tuning over PCM frames. */
  vad?: {
    /** RMS cutoff on the s16le scale (default 500). */
    silenceThresholdRms?: number;
    /** Continuous sub-threshold audio needed to end a turn (default 900ms). */
    silenceHangoverMs?: number;
    /** Minimum voiced audio before hangover can end a turn (default 250ms). */
    minSpeechMs?: number;
  };
}

type ProviderFailureKind = "timeout" | "connection" | "unavailable" | "aborted";

/** Internal only — never emitted; kinds map to safe error codes. */
class ProviderCallError extends Error {
  constructor(readonly kind: ProviderFailureKind) {
    super(kind);
    this.name = "ProviderCallError";
  }
}

function logWarn(event: string, error: unknown): void {
  console.warn(`[voice-openai-adapter] ${event}`, {
    error: error instanceof Error ? error.name : "UnknownError",
  });
}

/** Best-effort body cleanup — never awaited, never throws. */
function cancelBodyQuietly(cancel: () => Promise<void>): void {
  try {
    void cancel().catch((error: unknown) => logWarn("response_cleanup_failed", error));
  } catch (error: unknown) {
    logWarn("response_cleanup_failed", error);
  }
}

/** Canonical 44-byte PCM WAV header + s16le body. */
function encodeWavS16(pcm: Buffer, sampleRateHz: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format tag
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function f32leToS16le(input: Buffer): Buffer {
  const samples = Math.floor(input.length / 4);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.max(-1, Math.min(1, input.readFloatLE(i * 4)));
    out.writeInt16LE(Math.round(value * 32_767), i * 2);
  }
  return out;
}

function rmsS16le(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = chunk.readInt16LE(i * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/** f32le frames arrive normalized to [-1, 1]; scale to the s16le range so one threshold covers both. */
function rmsF32le(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 4);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = chunk.readFloatLE(i * 4);
    sum += value * value;
  }
  return Math.sqrt(sum / samples) * 32_768;
}

interface CaptureState {
  turnId: string;
  mode: VoiceTurnMode;
  chunks: Buffer[];
  bytes: number;
  overflowed: boolean;
  speechMs: number;
  inSpeech: boolean;
  silenceTimer: VoiceTimer | null;
}

interface ResponseSynthesis {
  queue: VoiceSynthesisCommand[];
  running: boolean;
  muted: boolean;
  abort: AbortController | null;
  /** Total PCM bytes emitted for the response — drives monotonic startMs. */
  bytesEmitted: number;
}

interface AdapterConfig {
  apiKey: string;
  transcriptionModel: string;
  speechModel: string;
  voice: string;
  fetchImpl: typeof fetch;
  clock: VoiceClock;
  maxCaptureBytes: number;
  maxSynthesisBytes: number;
  vad: { silenceThresholdRms: number; silenceHangoverMs: number; minSpeechMs: number };
}

class OpenAiVoiceMediaSession implements VoiceMediaSession {
  private readonly context: VoiceAdapterSessionContext;
  private readonly config: AdapterConfig;
  private closed = false;
  private capture: CaptureState | null = null;
  private readonly transcriptions = new Set<AbortController>();
  private readonly responses = new Map<string, ResponseSynthesis>();

  constructor(context: VoiceAdapterSessionContext, config: AdapterConfig) {
    this.context = context;
    this.config = config;
  }

  // ------------------------------------------------------------ engine commands

  setCapture(capture: { turnId: string; mode: VoiceTurnMode } | null): void {
    if (this.closed) return;
    if (capture === null) {
      this.finalizeCapture();
      return;
    }
    // A superseding capture silently discards the prior buffered turn.
    this.discardCapture();
    this.capture = {
      turnId: capture.turnId,
      mode: capture.mode,
      chunks: [],
      bytes: 0,
      overflowed: false,
      speechMs: 0,
      inSpeech: false,
      silenceTimer: null,
    };
  }

  pushAudio(input: { turnId: string; timestampMs: number; data: string }): void {
    const cap = this.capture;
    if (this.closed || !cap || cap.turnId !== input.turnId || cap.overflowed) return;
    let chunk: Buffer;
    try {
      chunk = Buffer.from(input.data, "base64");
    } catch (error: unknown) {
      logWarn("audio_decode_failed", error);
      return;
    }
    if (chunk.length === 0) return;
    if (cap.bytes + chunk.length > this.config.maxCaptureBytes) {
      cap.overflowed = true;
      cap.chunks = [];
      cap.bytes = 0;
      this.emit({ type: "error", code: "audio_backpressure", retryable: false, fatal: false });
      return;
    }
    cap.chunks.push(chunk);
    cap.bytes += chunk.length;
    this.runVad(cap, chunk);
  }

  synthesize(command: VoiceSynthesisCommand): void {
    if (this.closed) return;
    let resp = this.responses.get(command.responseId);
    if (!resp) {
      if (this.responses.size >= MAX_SYNTH_RESPONSES) {
        for (const [id, entry] of this.responses) {
          if (!entry.running && entry.queue.length === 0) this.responses.delete(id);
          if (this.responses.size < MAX_SYNTH_RESPONSES) break;
        }
        if (this.responses.size >= MAX_SYNTH_RESPONSES) return;
      }
      resp = { queue: [], running: false, muted: false, abort: null, bytesEmitted: 0 };
      this.responses.set(command.responseId, resp);
    }
    if (resp.muted || resp.queue.length >= MAX_QUEUED_SEGMENTS) return;
    resp.queue.push(command);
    void this.drainSynthesis(resp);
  }

  cancelResponse(responseId: string): void {
    this.muteResponse(responseId);
  }

  interrupt(responseId: string, _playedThroughMs: number): void {
    this.muteResponse(responseId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.discardCapture();
    for (const op of this.transcriptions) op.abort();
    this.transcriptions.clear();
    for (const resp of this.responses.values()) {
      resp.muted = true;
      resp.queue.length = 0;
      resp.abort?.abort();
    }
  }

  // --------------------------------------------------------------- capture vad

  private get audioCodec(): string {
    return this.context.audio?.codec ?? "pcm_s16le";
  }

  private get sampleRateHz(): number {
    return this.context.audio?.sampleRateHz ?? 16_000;
  }

  private get channels(): number {
    return this.context.audio?.channels ?? 1;
  }

  private frameMs(chunk: Buffer): number {
    const bytesPerSample = this.audioCodec === "pcm_f32le" ? 4 : 2;
    const bytesPerMs = (this.sampleRateHz * this.channels * bytesPerSample) / 1_000;
    return chunk.length / bytesPerMs;
  }

  private runVad(cap: CaptureState, chunk: Buffer): void {
    if (cap.mode !== "hands_free") return;
    const codec = this.audioCodec;
    if (codec !== "pcm_s16le" && codec !== "pcm_f32le") return; // capture boundaries decide
    const rms = codec === "pcm_s16le" ? rmsS16le(chunk) : rmsF32le(chunk);
    if (rms >= this.config.vad.silenceThresholdRms) {
      cap.speechMs += this.frameMs(chunk);
      if (!cap.inSpeech) {
        cap.inSpeech = true;
        this.emit({ type: "vad", turnId: cap.turnId, action: "speech_start" });
      }
      cap.silenceTimer?.cancel();
      cap.silenceTimer = null;
      return;
    }
    if (cap.inSpeech && !cap.silenceTimer) {
      cap.silenceTimer = this.config.clock.after(this.config.vad.silenceHangoverMs, () => {
        this.onSilenceHangover(cap);
      });
    }
  }

  private onSilenceHangover(cap: CaptureState): void {
    cap.silenceTimer = null;
    if (this.closed || this.capture !== cap || !cap.inSpeech) return;
    if (cap.speechMs >= this.config.vad.minSpeechMs) {
      this.emit({ type: "vad", turnId: cap.turnId, action: "speech_end" });
      this.finalizeCapture();
      return;
    }
    // Sub-minimum blip: keep listening without consuming the turn.
    cap.inSpeech = false;
    cap.speechMs = 0;
  }

  /** Ends the active capture (VAD end or `setCapture(null)`) and transcribes. */
  private finalizeCapture(): void {
    const cap = this.capture;
    if (!cap) return;
    this.capture = null;
    cap.silenceTimer?.cancel();
    cap.silenceTimer = null;
    const pcm = Buffer.concat(cap.chunks);
    cap.chunks = [];
    if (this.closed || pcm.length === 0) return;
    const codec = this.audioCodec;
    if (codec !== "pcm_s16le" && codec !== "pcm_f32le") {
      // We cannot decode non-PCM input into a WAV file.
      this.emit({ type: "error", code: "input_unavailable", retryable: false, fatal: false });
      return;
    }
    if (this.transcriptions.size >= MAX_INFLIGHT_TRANSCRIPTIONS) {
      this.emit({ type: "error", code: "provider_unavailable", retryable: true, fatal: false });
      return;
    }
    const s16 = codec === "pcm_f32le" ? f32leToS16le(pcm) : pcm;
    const wav = encodeWavS16(s16, this.sampleRateHz, this.channels);
    void this.transcribe(cap.turnId, wav);
  }

  private discardCapture(): void {
    const cap = this.capture;
    if (!cap) return;
    this.capture = null;
    cap.silenceTimer?.cancel();
    cap.silenceTimer = null;
    cap.chunks = [];
    cap.bytes = 0;
  }

  // ------------------------------------------------------------ provider calls

  private emit(event: VoiceAdapterEvent): void {
    if (this.closed) return;
    try {
      this.context.emit(event);
    } catch (error: unknown) {
      // A dead transport must not fault provider work already in flight.
      logWarn("emit_failed", error);
    }
  }

  /**
   * One bounded POST: deadline + per-operation abort combined into the fetch
   * signal, redirect rejection, auth header, and a classifier distinguishing
   * our own aborts from timeouts and network failures.
   */
  private async post(
    url: string,
    init: { body: BodyInit; extraHeaders?: Record<string, string> },
    timeoutMs: number,
    op: AbortController,
  ): Promise<{ response: Response; classify: () => ProviderCallError }> {
    const deadline = AbortSignal.timeout(timeoutMs);
    let abortedBy: "op" | "deadline" | undefined;
    const markOp = () => {
      abortedBy ??= "op";
    };
    const markDeadline = () => {
      abortedBy ??= "deadline";
    };
    op.signal.addEventListener("abort", markOp, { once: true });
    deadline.addEventListener("abort", markDeadline, { once: true });
    const classify = (): ProviderCallError => {
      if (abortedBy === "op" || op.signal.aborted || this.closed) {
        return new ProviderCallError("aborted");
      }
      if (abortedBy === "deadline" || deadline.aborted) {
        return new ProviderCallError("timeout");
      }
      return new ProviderCallError("connection");
    };
    try {
      const response = await this.config.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          ...init.extraHeaders,
        },
        body: init.body,
        signal: AbortSignal.any([deadline, op.signal]),
      });
      if (!response.ok) {
        if (response.body) {
          const body = response.body;
          cancelBodyQuietly(() => body.cancel());
        }
        throw new ProviderCallError("unavailable");
      }
      return { response, classify };
    } catch (error: unknown) {
      if (error instanceof ProviderCallError) throw error;
      if (abortedBy === "op" || op.signal.aborted || this.closed) {
        throw new ProviderCallError("aborted");
      }
      if (abortedBy === "deadline" || deadline.aborted) {
        throw new ProviderCallError("timeout");
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new ProviderCallError("timeout");
      }
      throw classify();
    } finally {
      op.signal.removeEventListener("abort", markOp);
      deadline.removeEventListener("abort", markDeadline);
    }
  }

  /** Maps internal failure kinds to the safe event vocabulary. */
  private emitCallFailure(error: unknown): void {
    const kind = error instanceof ProviderCallError ? error.kind : "connection";
    if (kind === "aborted") return; // close()/supersede are silent
    this.emit(
      kind === "unavailable"
        ? { type: "error", code: "provider_unavailable", retryable: true, fatal: false }
        : { type: "error", code: "connection_failed", retryable: true, fatal: false },
    );
  }

  private async transcribe(turnId: string, wav: Buffer): Promise<void> {
    const op = new AbortController();
    this.transcriptions.add(op);
    try {
      const form = new FormData();
      form.set("model", this.config.transcriptionModel);
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "capture.wav");
      form.set("response_format", "json");
      const { response, classify } = await this.post(
        TRANSCRIPTIONS_URL,
        { body: form },
        TRANSCRIPTION_TIMEOUT_MS,
        op,
      );
      const body = await this.readBoundedText(response, MAX_TRANSCRIPTION_RESPONSE_BYTES, classify);
      let text: string;
      try {
        const parsed = TranscriptionResponseSchema.safeParse(JSON.parse(body));
        if (!parsed.success) throw new Error("invalid transcription body");
        text = parsed.data.text.trim();
      } catch (error: unknown) {
        if (error instanceof ProviderCallError) throw error;
        throw new ProviderCallError("unavailable");
      }
      if (text.length === 0) return; // empty transcript: no event
      this.emit({ type: "transcript.final", turnId, finalityId: `trn_${turnId}`, text });
    } catch (error: unknown) {
      this.emitCallFailure(error);
    } finally {
      this.transcriptions.delete(op);
    }
  }

  private async readBoundedText(
    response: Response,
    maxBytes: number,
    classify: () => ProviderCallError,
  ): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0;
    let value = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          cancelBodyQuietly(() => reader.cancel());
          throw new ProviderCallError("unavailable");
        }
        value += decoder.decode(next.value, { stream: true });
      }
      value += decoder.decode();
      return value;
    } catch (error: unknown) {
      if (error instanceof ProviderCallError) throw error;
      const failure = classify();
      // Mid-body aborts keep their classification; truncated/undecodable
      // bodies are provider-side failures, not connection losses.
      throw failure.kind === "connection" ? new ProviderCallError("unavailable") : failure;
    } finally {
      reader.releaseLock();
    }
  }

  // --------------------------------------------------------------- synthesis

  private muteResponse(responseId: string): void {
    const resp = this.responses.get(responseId);
    if (!resp) return;
    resp.muted = true;
    resp.queue.length = 0;
    resp.abort?.abort();
  }

  private async drainSynthesis(resp: ResponseSynthesis): Promise<void> {
    if (resp.running) return;
    resp.running = true;
    try {
      while (!this.closed && !resp.muted) {
        const command = resp.queue.shift();
        if (!command) break;
        await this.runSynthesis(resp, command);
      }
    } finally {
      resp.running = false;
    }
  }

  private async runSynthesis(resp: ResponseSynthesis, command: VoiceSynthesisCommand): Promise<void> {
    const op = new AbortController();
    resp.abort = op;
    try {
      if (command.text.trim().length === 0) {
        this.emitSynthesisEnd(resp, command);
        return;
      }
      const { response, classify } = await this.post(
        SPEECH_URL,
        {
          body: JSON.stringify({
            model: this.config.speechModel,
            voice: this.config.voice,
            input: command.text,
            response_format: "pcm",
          }),
          extraHeaders: { "content-type": "application/json" },
        },
        SPEECH_TIMEOUT_MS,
        op,
      );
      if (!response.body) throw new ProviderCallError("unavailable");
      const reader = response.body.getReader();
      const pending: Buffer[] = [];
      let pendingBytes = 0;
      let totalBytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          pending.push(Buffer.from(next.value));
          pendingBytes += next.value.byteLength;
          totalBytes += next.value.byteLength;
          if (totalBytes > this.config.maxSynthesisBytes) {
            cancelBodyQuietly(() => reader.cancel());
            throw new ProviderCallError("unavailable");
          }
          while (pendingBytes >= SYNTH_CHUNK_BYTES) {
            const chunk = takeBytes(pending, SYNTH_CHUNK_BYTES);
            pendingBytes -= chunk.length;
            this.emitSynthesisChunk(resp, command, chunk);
          }
        }
        if (pendingBytes > 0) {
          const chunk = takeBytes(pending, pendingBytes);
          this.emitSynthesisChunk(resp, command, chunk);
        }
      } catch (error: unknown) {
        if (error instanceof ProviderCallError) throw error;
        throw classify();
      } finally {
        reader.releaseLock();
      }
      this.emitSynthesisEnd(resp, command);
    } catch (error: unknown) {
      if (!resp.muted) this.emitCallFailure(error);
    } finally {
      if (resp.abort === op) resp.abort = null;
    }
  }

  private emitSynthesisChunk(resp: ResponseSynthesis, command: VoiceSynthesisCommand, chunk: Buffer): void {
    if (this.closed || resp.muted || chunk.length === 0) return;
    const startMs = Math.round(resp.bytesEmitted / SYNTH_BYTES_PER_MS);
    resp.bytesEmitted += chunk.length;
    const endMs = Math.round(resp.bytesEmitted / SYNTH_BYTES_PER_MS);
    this.emit({
      type: "synthesis.audio",
      responseId: command.responseId,
      segmentId: command.segment.segmentId,
      startMs,
      durationMs: Math.max(1, endMs - startMs),
      data: chunk.toString("base64"),
    });
  }

  private emitSynthesisEnd(resp: ResponseSynthesis, command: VoiceSynthesisCommand): void {
    if (this.closed || resp.muted) return;
    this.emit({
      type: "synthesis.end",
      responseId: command.responseId,
      generatedDurationMs: Math.round(resp.bytesEmitted / SYNTH_BYTES_PER_MS),
    });
  }
}

/** Slice `size` bytes off the front of a pending buffer list. */
function takeBytes(pending: Buffer[], size: number): Buffer {
  const out = Buffer.alloc(size);
  let offset = 0;
  while (offset < size && pending.length > 0) {
    const head = pending[0]!;
    const need = size - offset;
    if (head.length <= need) {
      head.copy(out, offset);
      offset += head.length;
      pending.shift();
    } else {
      head.copy(out, offset, 0, need);
      pending[0] = head.subarray(need);
      offset += need;
    }
  }
  return out.subarray(0, offset);
}

/**
 * Build the adapter. Option validation happens up front (bounded slugs, byte
 * caps, VAD tuning) — a misconfigured adapter never reaches `start()`.
 */
export function createOpenAiVoiceMediaAdapter(options: OpenAiVoiceAdapterOptions): VoiceMediaAdapter {
  if (!options || typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new TypeError("Voice adapter requires an API key");
  }
  if (!MODEL_SLUG.test(options.transcriptionModel) || !MODEL_SLUG.test(options.speechModel)) {
    throw new TypeError("Voice adapter model identifiers are invalid");
  }
  if (!VOICE_SLUG.test(options.voice)) {
    throw new TypeError("Voice adapter voice identifier is invalid");
  }
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const maxSynthesisBytes = options.maxSynthesisBytes ?? DEFAULT_MAX_SYNTHESIS_BYTES;
  if (
    !Number.isSafeInteger(maxCaptureBytes)
    || maxCaptureBytes < 128
    || maxCaptureBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(maxSynthesisBytes)
    || maxSynthesisBytes < 128
    || maxSynthesisBytes > 64 * 1024 * 1024
  ) {
    throw new RangeError("Voice adapter byte caps are invalid");
  }
  const vad = {
    silenceThresholdRms: options.vad?.silenceThresholdRms ?? DEFAULT_VAD.silenceThresholdRms,
    silenceHangoverMs: options.vad?.silenceHangoverMs ?? DEFAULT_VAD.silenceHangoverMs,
    minSpeechMs: options.vad?.minSpeechMs ?? DEFAULT_VAD.minSpeechMs,
  };
  if (
    !Number.isFinite(vad.silenceThresholdRms)
    || vad.silenceThresholdRms < 0
    || !Number.isSafeInteger(vad.silenceHangoverMs)
    || vad.silenceHangoverMs < 50
    || vad.silenceHangoverMs > 60_000
    || !Number.isSafeInteger(vad.minSpeechMs)
    || vad.minSpeechMs < 0
    || vad.minSpeechMs > 60_000
  ) {
    throw new RangeError("Voice adapter VAD tuning is invalid");
  }
  const capabilities = VoiceAdapterCapabilitiesSchema.parse({
    transportModes: ["relayed_websocket"],
    turnModes: ["hands_free", "push_to_talk"],
    supportsInterruption: true,
    resume: "rebuild_only",
    // Canonical Chat has no per-run memory suppression yet, so no adapter may
    // claim enforceable session-only sessions — the capability projection and
    // the engine's admission gate must read the same truth. Flip to
    // "enforced" only when canonical suppression lands.
    sessionOnly: "unsupported",
    actionMode: "conversation_only",
    actionCancellation: "run",
    supportsInputSelection: true,
    supportsOutputSelection: true,
    ...options.capabilities,
  });
  const config: AdapterConfig = {
    apiKey: options.apiKey,
    transcriptionModel: options.transcriptionModel,
    speechModel: options.speechModel,
    voice: options.voice,
    fetchImpl: options.fetchImpl ?? fetch,
    clock: options.clock ?? createSystemVoiceClock(),
    maxCaptureBytes,
    maxSynthesisBytes,
    vad,
  };
  return {
    id: options.id ?? "openai",
    capabilities,
    start: (context) => new OpenAiVoiceMediaSession(context, config),
  };
}
