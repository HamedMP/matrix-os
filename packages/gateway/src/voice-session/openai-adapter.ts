/**
 * Chunked provider-neutral voice media adapter (Layer 4 seam).
 *
 * Capture frames are buffered per turn, encoded as canonical WAV, and handed
 * to an injected `VoiceSpeechPorts.transcribe`; canonical segment text goes
 * to `VoiceSpeechPorts.synthesize` and the yielded PCM chunks stream back as
 * bounded `synthesis.audio` frames. Provider frames never cross the adapter
 * port — only the shared contract vocabulary (`transcript.final`, `vad`,
 * `synthesis.*`, safe `error` codes).
 *
 * The adapter holds NO credentials and NO provider URLs. Speech ports are
 * injected: `createDirectOpenAiSpeechPorts` (development escape hatch) or a
 * managed pair (Platform Speech transcription + a dev-gated synthesizer)
 * composed by `adapter-registration.ts`. Output format is declared
 * separately from input: `speech.outputAudio` advertises the synthesis
 * decode format (OpenAI emits 24kHz s16le mono while capture negotiates
 * 16kHz) — it projects to `VoiceCapability.outputAudio` and stamps each
 * `synthesis.audio` frame so playback never decodes at the capture rate.
 *
 * `synthesis.end` is emitted once per drained segment command and carries
 * `segmentId`: the engine treats each one as segment-drained and keeps
 * response finalization for itself, so multi-segment responses no longer
 * terminate on the first clause's end. `generatedDurationMs` stays
 * cumulative (monotonic across the response).
 */
import type { VoiceTurnMode } from "@matrix-os/contracts/voice-session";
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
import {
  VoiceSpeechPortError,
  parseVoiceOutputAudio,
  sanitizeLanguageHints,
  voiceOutputBytesPerMs,
  type VoiceSpeechPorts,
} from "./speech-ports.js";

const SYNTH_CHUNK_BYTES = 24 * 1024;
const MAX_QUEUED_SEGMENTS = 16;
const MAX_SYNTH_RESPONSES = 64;
const MAX_INFLIGHT_TRANSCRIPTIONS = 4;
const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SYNTHESIS_BYTES = 16 * 1024 * 1024;
const DEFAULT_VAD = { silenceThresholdRms: 500, silenceHangoverMs: 900, minSpeechMs: 250 } as const;

const MAX_TRANSCRIPT_CHARS = 8_000;

export interface OpenAiVoiceAdapterOptions {
  /**
   * Injected speech pair. `synthesize` is REQUIRED — an adapter that hears
   * but never speaks is a registration defect, not a degraded session.
   */
  speech: VoiceSpeechPorts;
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

function logWarn(event: string, error: unknown): void {
  console.warn(`[voice-openai-adapter] ${event}`, {
    error: error instanceof Error ? error.name : "UnknownError",
  });
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
  speech: VoiceSpeechPorts;
  clock: VoiceClock;
  maxCaptureBytes: number;
  maxSynthesisBytes: number;
  vad: { silenceThresholdRms: number; silenceHangoverMs: number; minSpeechMs: number };
}

class ChunkedVoiceMediaSession implements VoiceMediaSession {
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
   * Normalize a port failure: an unclassified throw mid-abort is still an
   * abort (close/supersede stay silent); anything else without a kind is a
   * transport-level failure — never provider detail.
   */
  private classifySpeechError(error: unknown, op: AbortController): VoiceSpeechPortError {
    if (error instanceof VoiceSpeechPortError) return error;
    if (op.signal.aborted || this.closed) return new VoiceSpeechPortError("aborted");
    return new VoiceSpeechPortError("connection");
  }

  /** Maps classified port failures to the safe event vocabulary. */
  private emitCallFailure(error: VoiceSpeechPortError): void {
    if (error.kind === "aborted") return; // close()/supersede are silent
    this.emit(
      error.kind === "unavailable"
        ? { type: "error", code: "provider_unavailable", retryable: true, fatal: false }
        : { type: "error", code: "connection_failed", retryable: true, fatal: false },
    );
  }

  private async transcribe(turnId: string, wav: Buffer): Promise<void> {
    const op = new AbortController();
    this.transcriptions.add(op);
    try {
      const languageHints = sanitizeLanguageHints(
        this.context.locale ? [this.context.locale] : undefined,
      );
      const result = await this.config.speech.transcribe({
        wav,
        ...(languageHints ? { languageHints } : {}),
        signal: op.signal,
      });
      if (this.closed || op.signal.aborted) return; // late result: stay silent
      let text = result.text.trim();
      // Ports are trusted to bound; the adapter still enforces the wire cap.
      if ([...text].length > MAX_TRANSCRIPT_CHARS) {
        text = [...text].slice(0, MAX_TRANSCRIPT_CHARS).join("");
      }
      if (text.length === 0) return; // empty transcript: no event
      this.emit({ type: "transcript.final", turnId, finalityId: `trn_${turnId}`, text });
    } catch (error: unknown) {
      this.emitCallFailure(this.classifySpeechError(error, op));
    } finally {
      this.transcriptions.delete(op);
    }
  }

  // --------------------------------------------------------------- synthesis

  /** Byte-derived ms base of the DECLARED output stream (not the capture rate). */
  private get synthBytesPerMs(): number {
    return voiceOutputBytesPerMs(this.config.speech.outputAudio);
  }

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
      const stream = this.config.speech.synthesize({ text: command.text, signal: op.signal });
      const pending: Buffer[] = [];
      let pendingBytes = 0;
      let totalBytes = 0;
      for await (const part of stream) {
        pending.push(part);
        pendingBytes += part.length;
        totalBytes += part.length;
        if (totalBytes > this.config.maxSynthesisBytes) {
          throw new VoiceSpeechPortError("unavailable");
        }
        while (pendingBytes >= SYNTH_CHUNK_BYTES) {
          const piece = takeBytes(pending, SYNTH_CHUNK_BYTES);
          pendingBytes -= piece.length;
          this.emitSynthesisChunk(resp, command, piece);
        }
      }
      if (pendingBytes > 0) {
        const piece = takeBytes(pending, pendingBytes);
        this.emitSynthesisChunk(resp, command, piece);
      }
      this.emitSynthesisEnd(resp, command);
    } catch (error: unknown) {
      if (!resp.muted) this.emitCallFailure(this.classifySpeechError(error, op));
    } finally {
      if (resp.abort === op) resp.abort = null;
    }
  }

  private emitSynthesisChunk(resp: ResponseSynthesis, command: VoiceSynthesisCommand, chunk: Buffer): void {
    if (this.closed || resp.muted || chunk.length === 0) return;
    const bytesPerMs = this.synthBytesPerMs;
    const startMs = Math.round(resp.bytesEmitted / bytesPerMs);
    resp.bytesEmitted += chunk.length;
    const endMs = Math.round(resp.bytesEmitted / bytesPerMs);
    const outputAudio = this.config.speech.outputAudio;
    this.emit({
      type: "synthesis.audio",
      responseId: command.responseId,
      segmentId: command.segment.segmentId,
      startMs,
      durationMs: Math.max(1, endMs - startMs),
      data: chunk.toString("base64"),
      // Declare the real decode rate on every frame — capture format ≠ output
      // format (16kHz negotiated vs 24kHz synthesized).
      ...(outputAudio ? { format: outputAudio } : {}),
    });
  }

  private emitSynthesisEnd(resp: ResponseSynthesis, command: VoiceSynthesisCommand): void {
    if (this.closed || resp.muted) return;
    this.emit({
      type: "synthesis.end",
      responseId: command.responseId,
      generatedDurationMs: Math.round(resp.bytesEmitted / this.synthBytesPerMs),
      // Per-command terminal: exactly this segment drained. The engine owns
      // response finalization; generatedDurationMs stays cumulative.
      segmentId: command.segment.segmentId,
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
 * Build the adapter. Option validation happens up front (speech port pair,
 * declared output format, byte caps, VAD tuning) — a misconfigured adapter
 * never reaches `start()`.
 */
export function createOpenAiVoiceMediaAdapter(options: OpenAiVoiceAdapterOptions): VoiceMediaAdapter {
  if (
    !options
    || typeof options.speech !== "object"
    || options.speech === null
    || typeof options.speech.transcribe !== "function"
    || typeof options.speech.synthesize !== "function"
  ) {
    throw new TypeError("Voice adapter requires transcription and synthesis speech ports");
  }
  const outputAudio = parseVoiceOutputAudio(options.speech.outputAudio);
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
    ...(outputAudio ? { outputAudio } : {}),
    ...options.capabilities,
  });
  const config: AdapterConfig = {
    speech: options.speech,
    clock: options.clock ?? createSystemVoiceClock(),
    maxCaptureBytes,
    maxSynthesisBytes,
    vad,
  };
  return {
    id: options.id ?? "openai",
    capabilities,
    start: (context) => new ChunkedVoiceMediaSession(context, config),
  };
}
