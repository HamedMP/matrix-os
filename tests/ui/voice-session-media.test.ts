import { describe, expect, it, vi } from "vitest";
import {
  createWebVoiceMediaSession,
  decodeBase64,
  encodeBase64,
  VoiceMediaError,
  type VoiceAudioContextLike,
  type VoiceCaptureFactory,
  type VoiceMediaCallbacks,
  type VoiceMediaDevicesLike,
  type VoiceMediaStreamLike,
  type VoicePcmBuffer,
  type VoicePlaybackSource,
} from "../../packages/ui/src/voice-session/media-session";
import type { AudioFormat, VoicePlaybackAck } from "../../packages/contracts/src/voice-session";

const AUDIO: AudioFormat = { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 };
const CHUNK_SAMPLES = 320; // 20ms at 16kHz

class FakeSource implements VoicePlaybackSource {
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;

  constructor(readonly buffer: VoicePcmBuffer) {}

  start(atSeconds?: number): void {
    this.startedAt = atSeconds ?? null;
  }

  stop(): void {
    this.stopped = true;
    this.onended?.();
  }

  finish(): void {
    this.onended?.();
  }
}

function fakePlaybackContext() {
  let nowSeconds = 0;
  const sources: FakeSource[] = [];
  const context: VoiceAudioContextLike = {
    get currentTimeSeconds() {
      return nowSeconds;
    },
    sampleRateHz: 16_000,
    createPcmBuffer: ({ samples }) => ({
      durationMs: (samples.length / 16_000) * 1_000,
      native: samples,
    }),
    createSource: (buffer) => {
      const source = new FakeSource(buffer);
      sources.push(source);
      return source;
    },
    close: vi.fn(async () => undefined),
  };
  return { context, sources, setNow: (value: number) => { nowSeconds = value; } };
}

function fakeMediaDevices(getUserMediaImpl?: () => Promise<unknown>) {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_default" }) };
  const stream: VoiceMediaStreamLike = { getTracks: () => [track] };
  const deviceHandlers = new Set<() => void>();
  const devices: VoiceMediaDevicesLike = {
    getUserMedia: vi.fn(getUserMediaImpl ?? (async () => stream)),
    addEventListener: (type, listener) => {
      if (type === "devicechange") deviceHandlers.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "devicechange") deviceHandlers.delete(listener);
    },
  };
  return {
    devices,
    stream,
    track,
    deviceHandlerCount: () => deviceHandlers.size,
    fireDeviceChange: () => {
      for (const handler of [...deviceHandlers]) handler();
    },
  };
}

interface MediaHarness {
  session: ReturnType<typeof createWebVoiceMediaSession>;
  callbacks: VoiceMediaCallbacks;
  chunks: { turnId: string; timestampMs: number; data: string }[];
  acks: VoicePlaybackAck[];
  backpressure: number[];
  errors: { code: string }[];
  deviceChanges: { inputDeviceId?: string }[];
  playback: ReturnType<typeof fakePlaybackContext>;
  devices: ReturnType<typeof fakeMediaDevices>;
  captureStop: ReturnType<typeof vi.fn>;
  emitSamples: (samples: Float32Array) => void;
  setNow: (value: number) => void;
  acceptChunks: { current: boolean };
}

function mediaHarness(options: {
  getUserMediaImpl?: () => Promise<unknown>;
  maxInFlightMs?: number;
  acceptChunks?: boolean;
  captureSampleRateHz?: number;
} = {}): MediaHarness {
  const chunks: MediaHarness["chunks"] = [];
  const acks: VoicePlaybackAck[] = [];
  const backpressure: number[] = [];
  const errors: { code: string }[] = [];
  const deviceChanges: { inputDeviceId?: string }[] = [];
  const acceptChunks = { current: options.acceptChunks ?? true };
  const playback = fakePlaybackContext();
  const devices = fakeMediaDevices(options.getUserMediaImpl);
  const captureStop = vi.fn(async () => undefined);
  let emitSamples: (samples: Float32Array) => void = () => undefined;
  const captureFactory: VoiceCaptureFactory = ({ onSamples }) => {
    emitSamples = onSamples;
    return { sampleRateHz: options.captureSampleRateHz ?? 16_000, stop: captureStop };
  };
  let now = 5_000;
  const callbacks: VoiceMediaCallbacks = {
    onAudioChunk: (chunk) => {
      if (!acceptChunks.current) return false;
      chunks.push(chunk);
      return true;
    },
    onSegmentPlayed: (ack) => acks.push(ack),
    onBackpressure: (dropped) => backpressure.push(dropped),
    onDeviceChanged: (change) => deviceChanges.push(change),
    onError: (error) => errors.push(error),
  };
  const session = createWebVoiceMediaSession({
    audio: AUDIO,
    callbacks,
    mediaDevices: devices.devices,
    createAudioContext: () => playback.context,
    captureFactory,
    maxInFlightMs: options.maxInFlightMs,
    now: () => now,
  });
  return {
    session,
    callbacks,
    chunks,
    acks,
    backpressure,
    errors,
    deviceChanges,
    playback,
    devices,
    captureStop,
    emitSamples: (samples) => emitSamples(samples),
    setNow: (value) => { now = value; },
    acceptChunks,
  };
}

const silence = (count: number, value = 0): Float32Array => new Float32Array(count).fill(value);
const pcmSegment = (samples: number): string => encodeBase64(new Uint8Array(samples * 2));

describe("createWebVoiceMediaSession", () => {
  it("runs the rationale hook before requesting the microphone and marks prepared", async () => {
    const order: string[] = [];
    const { session } = mediaHarness({
      getUserMediaImpl: async () => {
        order.push("getUserMedia");
        return { getTracks: () => [] };
      },
    });
    await session.prepare({ onRationale: () => { order.push("rationale"); } });
    expect(order).toEqual(["rationale", "getUserMedia"]);
    expect(session.supported).toBe(true);
  });

  it("maps microphone denial to permission_denied and missing devices to input_unavailable", async () => {
    const denied = mediaHarness({
      getUserMediaImpl: async () => {
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      },
    });
    await expect(denied.session.prepare()).rejects.toMatchObject({
      name: "VoiceMediaError",
      safeError: { code: "permission_denied", recovery: "request_permission", retryable: true },
    });

    const missing = mediaHarness({
      getUserMediaImpl: async () => {
        throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      },
    });
    await expect(missing.session.prepare()).rejects.toMatchObject({
      safeError: { code: "input_unavailable", recovery: "choose_input" },
    });
  });

  it("reports unsupported_surface when no media devices exist", async () => {
    const session = createWebVoiceMediaSession({
      audio: AUDIO,
      callbacks: { onAudioChunk: () => true, onSegmentPlayed: () => undefined },
      mediaDevices: null,
      createAudioContext: () => fakePlaybackContext().context,
      captureFactory: () => ({ sampleRateHz: 16_000, stop: vi.fn() }),
    });
    expect(session.supported).toBe(false);
    await expect(session.prepare()).rejects.toMatchObject({
      safeError: { code: "unsupported_surface" },
    });
  });

  it("encodes bounded capture.audio chunks as base64 pcm_s16le", async () => {
    const { session, emitSamples, chunks } = mediaHarness();
    await session.prepare();
    expect(session.startCapture({ turnId: "vturn_1" })).toBe(true);

    emitSamples(silence(CHUNK_SAMPLES, 0.5));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ turnId: "vturn_1" });
    const decoded = decodeBase64(chunks[0]!.data);
    expect(decoded?.byteLength).toBe(CHUNK_SAMPLES * 2);
    const view = new DataView(decoded!.buffer);
    expect(view.getInt16(0, true)).toBe(16_384); // round(0.5 * 32767)

    // Partial chunks accumulate across callbacks until a full frame exists.
    emitSamples(silence(CHUNK_SAMPLES + 40, 0.25));
    emitSamples(silence(CHUNK_SAMPLES - 40, 0.25));
    expect(chunks).toHaveLength(3);
  });

  it("resamples the browser capture rate to the 16kHz wire format it advertises", async () => {
    const { session, emitSamples, chunks } = mediaHarness({ captureSampleRateHz: 48_000 });
    await session.prepare();
    session.startCapture({ turnId: "vturn_rate" });

    // 20ms from a browser that ignored the requested 16kHz AudioContext rate.
    emitSamples(silence(960, 0.5));
    expect(chunks).toHaveLength(1);
    const decoded = decodeBase64(chunks[0]!.data);
    expect(decoded?.byteLength).toBe(CHUNK_SAMPLES * 2);
    expect(session.pendingAudioMs()).toBe(0);
  });

  it("keeps a single capture owner across turn switches", async () => {
    const { session, emitSamples, chunks } = mediaHarness();
    await session.prepare();
    expect(session.startCapture({ turnId: "vturn_1" })).toBe(true);
    emitSamples(silence(CHUNK_SAMPLES));
    // A second turn replaces the in-flight one; prior partial audio is discarded.
    emitSamples(silence(10));
    expect(session.startCapture({ turnId: "vturn_2" })).toBe(true);
    emitSamples(silence(CHUNK_SAMPLES));
    expect(chunks.map((chunk) => chunk.turnId)).toEqual(["vturn_1", "vturn_2"]);
    session.stopCapture();
    emitSamples(silence(CHUNK_SAMPLES));
    expect(chunks).toHaveLength(2);
  });

  it("bounds the in-flight capture queue, drops oldest, and signals backpressure", async () => {
    // 60ms in-flight ceiling = 3 chunks of 20ms.
    const { session, emitSamples, chunks, backpressure, acceptChunks } = mediaHarness({
      maxInFlightMs: 60,
      acceptChunks: false,
    });
    await session.prepare();
    session.startCapture({ turnId: "vturn_1" });
    emitSamples(silence(CHUNK_SAMPLES, 0.1));
    emitSamples(silence(CHUNK_SAMPLES, 0.2));
    emitSamples(silence(CHUNK_SAMPLES, 0.3));
    emitSamples(silence(CHUNK_SAMPLES, 0.4));
    expect(backpressure.length).toBeGreaterThan(0);
    expect(chunks).toHaveLength(0);

    acceptChunks.current = true;
    emitSamples(silence(CHUNK_SAMPLES, 0.5));
    // Two oldest queued chunks (0.1, 0.2) were dropped; retained audio drains in order.
    const amplitudes = chunks.map((chunk) => {
      const decoded = decodeBase64(chunk.data)!;
      return new DataView(decoded.buffer).getInt16(0, true);
    });
    expect(amplitudes).toEqual([
      Math.round(0.3 * 32_767),
      Math.round(0.4 * 32_767),
      Math.round(0.5 * 32_767),
    ]);
  });

  it("reports playback.segment_played with cumulative playedThroughMs and delivery revisions", async () => {
    const { session, playback, acks } = mediaHarness();
    await session.prepare();

    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) }); // 200ms
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_2", data: pcmSegment(1_600) }); // 100ms
    expect(playback.sources).toHaveLength(1);
    playback.sources[0]!.finish();
    expect(acks).toEqual([
      { responseId: "vresp_1", segmentId: "vseg_1", deliveryRevision: 1, playedThroughMs: 200 },
    ]);
    // The second segment was scheduled back-to-back and acked on completion.
    expect(playback.sources).toHaveLength(2);
    playback.sources[1]!.finish();
    expect(acks[1]).toEqual({
      responseId: "vresp_1", segmentId: "vseg_2", deliveryRevision: 2, playedThroughMs: 300,
    });
  });

  it("returns the true played boundary on response.interrupt mid-segment", async () => {
    const { session, playback, acks } = mediaHarness();
    await session.prepare();
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) }); // 200ms
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_2", data: pcmSegment(3_200) });
    expect(playback.sources[0]!.startedAt).toBe(0);

    // 150ms into the first segment the user barges in.
    playback.setNow(0.15);
    const boundary = session.interruptResponse("vresp_1");
    expect(boundary).toBe(150);
    expect(playback.sources[0]!.stopped).toBe(true);
    // An interrupted segment emits no played ack, and queued audio is discarded.
    expect(acks).toHaveLength(0);
    expect(session.playedThroughMs("vresp_1")).toBeNull();
    expect(session.interruptResponse("vresp_1")).toBeNull();
  });

  it("emits device.changed through the callback when devices churn", async () => {
    const { session, devices, deviceChanges } = mediaHarness();
    await session.prepare();
    devices.fireDeviceChange();
    expect(deviceChanges).toEqual([{ inputDeviceId: "mic_default" }]);
  });

  it("fails startCapture before permission prepare and after release", async () => {
    const { session, errors } = mediaHarness();
    expect(session.startCapture({ turnId: "vturn_1" })).toBe(false);
    expect(errors[0]?.code).toBe("input_unavailable");

    await session.prepare();
    await session.release();
    expect(session.startCapture({ turnId: "vturn_1" })).toBe(false);
  });

  it("releases tracks, capture, playback sources, and listeners exactly once", async () => {
    const { session, devices, playback, captureStop } = mediaHarness();
    await session.prepare();
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(3_200) });
    await session.release();

    expect(devices.track.stop).toHaveBeenCalledOnce();
    expect(captureStop).toHaveBeenCalledOnce();
    expect(playback.sources[0]!.stopped).toBe(true);
    expect(playback.context.close).toHaveBeenCalledOnce();
    expect(devices.deviceHandlerCount()).toBe(0);

    await session.release();
    expect(devices.track.stop).toHaveBeenCalledOnce();
  });
});

describe("voice media device selection", () => {
  it("keeps the newest overlapping acquisition and disposes a stale stream that resolves last", async () => {
    type Deferred = { resolve: (stream: VoiceMediaStreamLike) => void; promise: Promise<VoiceMediaStreamLike> };
    const deferred = (): Deferred => {
      let resolve!: Deferred["resolve"];
      const promise = new Promise<VoiceMediaStreamLike>((done) => { resolve = done; });
      return { resolve, promise };
    };
    const requestA = deferred();
    const requestB = deferred();
    const baselineTrack = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_baseline" }) };
    const trackA = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_a" }) };
    const trackB = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_b" }) };
    const streams = {
      baseline: { getTracks: () => [baselineTrack] },
      a: { getTracks: () => [trackA] },
      b: { getTracks: () => [trackB] },
    } satisfies Record<string, VoiceMediaStreamLike>;
    let call = 0;
    const captureStops = new Map<string, ReturnType<typeof vi.fn>>();
    const devices: VoiceMediaDevicesLike = {
      getUserMedia: vi.fn(async () => {
        call += 1;
        if (call === 1) return streams.baseline;
        return call === 2 ? requestA.promise : requestB.promise;
      }),
    };
    const session = createWebVoiceMediaSession({
      audio: AUDIO,
      callbacks: { onAudioChunk: () => true, onSegmentPlayed: () => undefined },
      mediaDevices: devices,
      createAudioContext: () => fakePlaybackContext().context,
      captureFactory: ({ stream }) => {
        const id = stream.getTracks()[0]!.getSettings?.().deviceId ?? "unknown";
        const stop = vi.fn(async () => undefined);
        captureStops.set(id, stop);
        return { sampleRateHz: 16_000, stop };
      },
    });
    await session.prepare();

    const switchA = session.switchInputDevice!("mic_a");
    const switchB = session.switchInputDevice!("mic_b");
    requestB.resolve(streams.b);
    await switchB;
    requestA.resolve(streams.a);
    await expect(switchA).rejects.toMatchObject({ safeError: { code: "input_unavailable" } });

    expect(trackA.stop).toHaveBeenCalledOnce();
    expect(captureStops.has("mic_a")).toBe(false);
    expect(trackB.stop).not.toHaveBeenCalled();
    await session.release();
    expect(trackB.stop).toHaveBeenCalledOnce();
    expect(captureStops.get("mic_b")).toHaveBeenCalledOnce();
  });

  it("release fences an in-flight acquisition and disposes its late stream", async () => {
    let resolve!: (stream: VoiceMediaStreamLike) => void;
    const pending = new Promise<VoiceMediaStreamLike>((done) => { resolve = done; });
    const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_late" }) };
    const captureStop = vi.fn(async () => undefined);
    const session = createWebVoiceMediaSession({
      audio: AUDIO,
      callbacks: { onAudioChunk: () => true, onSegmentPlayed: () => undefined },
      mediaDevices: { getUserMedia: vi.fn(async () => pending) },
      createAudioContext: () => fakePlaybackContext().context,
      captureFactory: () => ({ sampleRateHz: 16_000, stop: captureStop }),
    });
    const preparing = session.prepare();
    await session.release();
    resolve({ getTracks: () => [track] });
    await expect(preparing).rejects.toMatchObject({ safeError: { code: "input_unavailable" } });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(captureStop).not.toHaveBeenCalled();
  });

  it("requests the exact input device id at prepare", async () => {
    const { session, devices } = mediaHarness();
    await session.prepare({ inputDeviceId: "mic_b" });
    expect(devices.devices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: "mic_b" },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });

  it("hot-swaps capture to another input without touching playback", async () => {
    const trackB = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_b" }) };
    const streamB: VoiceMediaStreamLike = { getTracks: () => [trackB] };
    let calls = 0;
    const { session, devices, emitSamples, chunks } = mediaHarness({
      getUserMediaImpl: async () => {
        calls += 1;
        return calls === 1 ? devices.stream : streamB;
      },
    });
    await session.prepare({ inputDeviceId: "mic_a" });
    session.startCapture({ turnId: "vturn_1" });
    emitSamples(silence(CHUNK_SAMPLES));

    await session.switchInputDevice?.("mic_b");
    expect(devices.devices.getUserMedia).toHaveBeenLastCalledWith({
      audio: {
        deviceId: { exact: "mic_b" },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // The old mic track was retired; capture on the new device resumes cleanly.
    expect(devices.track.stop).toHaveBeenCalled();
    session.startCapture({ turnId: "vturn_2" });
    emitSamples(silence(CHUNK_SAMPLES));
    expect(chunks.map((chunk) => chunk.turnId)).toEqual(["vturn_1", "vturn_2"]);
    // Playback was never disturbed: the playback context was not closed.
    expect(devices.deviceHandlerCount()).toBeGreaterThan(0);
  });

  it("maps a failed hot swap to input_unavailable through the rejection", async () => {
    let calls = 0;
    const { session } = mediaHarness({
      getUserMediaImpl: async () => {
        calls += 1;
        if (calls === 1) return { getTracks: () => [] };
        throw Object.assign(new Error("gone"), { name: "NotFoundError" });
      },
    });
    await session.prepare();
    await expect(session.switchInputDevice?.("mic_lost")).rejects.toMatchObject({
      safeError: { code: "input_unavailable" },
    });
  });

  it("applies setSinkId to the live playback context and resets to default", async () => {
    const { session, playback } = mediaHarness();
    const setSinkId = vi.fn(async (_id: string) => undefined);
    playback.context.setSinkId = setSinkId;
    await session.prepare();
    // Create the playback context lazily via a segment enqueue.
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(320) });
    await expect(session.setOutputDevice?.("spk_a")).resolves.toBe("applied");
    expect(setSinkId).toHaveBeenCalledWith("spk_a");
    await expect(session.setOutputDevice?.(null)).resolves.toBe("applied");
    expect(setSinkId).toHaveBeenCalledWith("");
  });

  it("reports unsupported when the context cannot route and unavailable after release", async () => {
    const { session, playback } = mediaHarness();
    await session.prepare();
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(320) });
    // Fake context has no setSinkId.
    await expect(session.setOutputDevice?.("spk_a")).resolves.toBe("unsupported");
    expect(playback.context.setSinkId).toBeUndefined();
    await session.release();
    await expect(session.setOutputDevice?.("spk_a")).resolves.toBe("unavailable");
  });

  it("defers a preferred sink to playback-context creation and surfaces apply failure", async () => {
    const { session, playback, errors } = mediaHarness();
    const failing = vi.fn(async () => { throw new Error("no sink"); });
    playback.context.setSinkId = failing;
    await session.prepare();
    // No playback context exists yet: the selection is recorded as pending.
    await expect(session.setOutputDevice?.("spk_a")).resolves.toBe("applied");
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(320) });
    await vi.waitFor(() => expect(failing).toHaveBeenCalledWith("spk_a"));
    await vi.waitFor(() => expect(errors.some((e) => e.code === "output_unavailable")).toBe(true));
  });

  it("does not start playback until deferred output routing settles", async () => {
    const { session, playback } = mediaHarness();
    let resolveSink!: () => void;
    playback.context.setSinkId = vi.fn(() => new Promise<void>((resolve) => { resolveSink = resolve; }));
    await session.prepare();
    await expect(session.setOutputDevice?.("spk_a")).resolves.toBe("applied");
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(320) });
    expect(playback.sources).toHaveLength(0);
    resolveSink();
    await vi.waitFor(() => expect(playback.sources).toHaveLength(1));
    expect(playback.sources[0]!.startedAt).toBe(0);
  });

  it("never starts or acknowledges playback when explicit output routing rejects", async () => {
    const { session, playback, errors, acks } = mediaHarness();
    let rejectSink!: (error: Error) => void;
    playback.context.setSinkId = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSink = reject; }));
    await session.prepare();
    await expect(session.setOutputDevice?.("spk_a")).resolves.toBe("applied");
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_1", data: pcmSegment(320) });
    rejectSink(new Error("routing failed"));
    await vi.waitFor(() => expect(errors).toContainEqual(expect.objectContaining({ code: "output_unavailable" })));
    session.enqueueSegment({ responseId: "vresp_1", segmentId: "vseg_2", data: pcmSegment(320) });
    session.enqueueSegment({ responseId: "vresp_2", segmentId: "vseg_3", data: pcmSegment(320) });
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.sources).toHaveLength(0);
    expect(acks).toHaveLength(0);
    playback.context.setSinkId = vi.fn(async () => undefined);
    await expect(session.setOutputDevice?.("spk_b")).resolves.toBe("applied");
    session.enqueueSegment({ responseId: "vresp_3", segmentId: "vseg_4", data: pcmSegment(320) });
    await vi.waitFor(() => expect(playback.sources).toHaveLength(1));
  });
});

describe("capture-side AudioContext readiness", () => {
  function readinessHarness(ensureReady?: () => void | Promise<void>) {
    const track = { stop: vi.fn(), getSettings: () => ({ deviceId: "mic_default" }) };
    const stream: VoiceMediaStreamLike = { getTracks: () => [track] };
    const devices: VoiceMediaDevicesLike = { getUserMedia: vi.fn(async () => stream) };
    const captureStop = vi.fn(async () => undefined);
    const ready = vi.fn(ensureReady ?? (() => undefined));
    const captureFactory: VoiceCaptureFactory = () => ({
      sampleRateHz: 16_000,
      ensureReady: ready,
      stop: captureStop,
    });
    const errors: { code: string }[] = [];
    const session = createWebVoiceMediaSession({
      audio: AUDIO,
      callbacks: {
        onAudioChunk: () => true,
        onSegmentPlayed: () => undefined,
        onError: (error) => errors.push(error),
      },
      mediaDevices: devices,
      createAudioContext: () => fakePlaybackContext().context,
      captureFactory,
    });
    return { session, track, captureStop, ready, errors };
  }

  it("observes capture readiness inside prepare and marks the session prepared", async () => {
    const { session, ready } = readinessHarness();
    await session.prepare();
    expect(ready).toHaveBeenCalledOnce();
    expect(session.startCapture({ turnId: "vturn_1" })).toBe(true);
    await session.release();
  });

  it("fails prepare as input_unavailable and releases the partial allocation when readiness rejects", async () => {
    const { session, track, captureStop } = readinessHarness(async () => {
      throw new Error("AudioContext resume blocked");
    });
    await expect(session.prepare()).rejects.toMatchObject({
      name: "VoiceMediaError",
      safeError: { code: "input_unavailable", recovery: "choose_input", retryable: true },
    });
    // The half-prepared mic and capture handle are released, not leaked.
    expect(track.stop).toHaveBeenCalledOnce();
    expect(captureStop).toHaveBeenCalledOnce();
    // The session never becomes capturable after a failed prepare.
    expect(session.startCapture({ turnId: "vturn_1" })).toBe(false);
  });

  it("propagates a VoiceMediaError from ensureReady unchanged", async () => {
    const { session } = readinessHarness(async () => {
      throw new VoiceMediaError({ code: "input_unavailable", recovery: "choose_input", retryable: true });
    });
    await expect(session.prepare()).rejects.toMatchObject({
      safeError: { code: "input_unavailable", recovery: "choose_input" },
    });
  });
});
