import { PlatformSpeechRecorderError } from "@matrix-os/ui/speech";

import {
  createMicrophoneCaptureAdapter,
  MicrophonePermissionError,
  type MicrophoneStream,
} from "../lib/speech/capture";
import type { PcmBuffer } from "../lib/speech/pcm-collector";

type BufferListener = (buffer: PcmBuffer) => void;
type StatusListener = (status: { isStreaming: boolean }) => void;

function fakeStream(overrides: Partial<MicrophoneStream> = {}) {
  const listeners: { buffer: BufferListener | null; status: StatusListener | null } = { buffer: null, status: null };
  const removed = { buffer: 0, status: 0 };
  const stream: MicrophoneStream = {
    start: jest.fn(async () => undefined),
    stop: jest.fn(),
    onBuffer: jest.fn((listener: BufferListener) => {
      listeners.buffer = listener;
      return { remove: () => { removed.buffer += 1; listeners.buffer = null; } };
    }),
    onStatus: jest.fn((listener: StatusListener) => {
      listeners.status = listener;
      return { remove: () => { removed.status += 1; listeners.status = null; } };
    }),
    ...overrides,
  };
  return {
    stream,
    removed,
    deliver: (samples: readonly number[]) => listeners.buffer?.({ data: new Int16Array(samples).buffer, sampleRate: 16_000, channels: 1 }),
    deliverRaw: (buffer: PcmBuffer) => listeners.buffer?.(buffer),
    status: (isStreaming: boolean) => listeners.status?.({ isStreaming }),
  };
}

function adapterFor(
  stream: MicrophoneStream,
  options: { permission?: () => Promise<{ granted: boolean; canAskAgain: boolean }>; onEnded?: () => void } = {},
) {
  const releaseAudioSession = jest.fn();
  const onEnded = options.onEnded ?? jest.fn();
  const adapter = createMicrophoneCaptureAdapter({
    stream,
    requestPermission: options.permission ?? (async () => ({ granted: true, canAskAgain: true })),
    releaseAudioSession,
    onEnded,
  });
  return { adapter, releaseAudioSession, onEnded };
}

const START = { maxBytes: 10_000 };

describe("createMicrophoneCaptureAdapter", () => {
  it("records the microphone and hands back a WAV when stopped", async () => {
    const mic = fakeStream();
    const { adapter, releaseAudioSession } = adapterFor(mic.stream);
    const onLevel = jest.fn();

    const capture = await adapter.start({ ...START, signal: new AbortController().signal, onLevel });
    mic.deliver([1_000, -1_000, 2_000]);
    const recording = await capture.stop();

    expect(mic.stream.start).toHaveBeenCalledTimes(1);
    expect(recording.type).toBe("audio/wav");
    expect(recording.size).toBe(44 + 6);
    expect(recording.bytes.byteLength).toBe(recording.size);
    expect(onLevel).toHaveBeenCalledTimes(1);
    expect(onLevel.mock.calls[0]![0]).toBeGreaterThan(0);
    expect(mic.removed).toEqual({ buffer: 1, status: 1 });
    expect(mic.stream.stop).toHaveBeenCalledTimes(1);
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it("is ready to use on any phone", () => {
    expect(adapterFor(fakeStream().stream).adapter.isSupported()).toBe(true);
  });

  it("does not open the microphone when permission is refused, and says whether it can be asked again", async () => {
    const mic = fakeStream();
    const { adapter } = adapterFor(mic.stream, { permission: async () => ({ granted: false, canAskAgain: false }) });

    const started = adapter.start({ ...START, signal: new AbortController().signal });

    await expect(started).rejects.toBeInstanceOf(MicrophonePermissionError);
    await expect(started).rejects.toMatchObject({ canAskAgain: false, safeMessage: "Microphone access is off" });
    expect(mic.stream.start).not.toHaveBeenCalled();
  });

  it("does not open the microphone when the recording is cancelled while permission is asked", async () => {
    const mic = fakeStream();
    let answer!: (permission: { granted: boolean; canAskAgain: boolean }) => void;
    const { adapter } = adapterFor(mic.stream, { permission: () => new Promise((resolve) => { answer = resolve; }) });
    const controller = new AbortController();

    const started = adapter.start({ ...START, signal: controller.signal });
    controller.abort();
    answer({ granted: true, canAskAgain: true });

    await expect(started).rejects.toThrow();
    expect(mic.stream.start).not.toHaveBeenCalled();
  });

  it("closes the microphone again when the recording is cancelled while it opens", async () => {
    // Like the native stream: a stop before it is open does nothing.
    let open = false;
    let opened!: () => void;
    const mic = fakeStream({
      start: jest.fn(() => new Promise<void>((resolve) => { opened = () => { open = true; resolve(); }; })),
      stop: jest.fn(() => { open = false; }),
    });
    const { adapter, releaseAudioSession } = adapterFor(mic.stream);
    const controller = new AbortController();

    const started = adapter.start({ ...START, signal: controller.signal });
    for (let tick = 0; tick < 10 && jest.mocked(mic.stream.start).mock.calls.length === 0; tick += 1) {
      await Promise.resolve();
    }
    controller.abort();
    opened();

    await expect(started).rejects.toThrow();
    expect(open).toBe(false);
    expect(releaseAudioSession).toHaveBeenCalled();
    expect(mic.removed).toEqual({ buffer: 1, status: 1 });
  });

  it("gives a safe message, and lets go of the microphone, when it cannot be opened", async () => {
    const mic = fakeStream({ start: jest.fn(async () => { throw new Error("AVAudioSession: internal detail"); }) });
    const { adapter, releaseAudioSession } = adapterFor(mic.stream);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const started = adapter.start({ ...START, signal: new AbortController().signal });

    await expect(started).rejects.toBeInstanceOf(PlatformSpeechRecorderError);
    await expect(started).rejects.toMatchObject({ safeMessage: "Microphone access is unavailable" });
    expect(releaseAudioSession).toHaveBeenCalled();
    expect(mic.removed).toEqual({ buffer: 1, status: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("internal detail");
    warn.mockRestore();
  });

  it("forgets the recording when cancelled", async () => {
    const mic = fakeStream();
    const { adapter } = adapterFor(mic.stream);
    const capture = await adapter.start({ ...START, signal: new AbortController().signal });
    mic.deliver([1, 2, 3]);

    await capture.cancel();

    expect(mic.stream.stop).toHaveBeenCalledTimes(1);
    await expect(capture.stop()).rejects.toBeInstanceOf(PlatformSpeechRecorderError);
  });

  it("says the recording ended when the system stops the microphone", async () => {
    const mic = fakeStream();
    const { adapter, onEnded } = adapterFor(mic.stream);
    await adapter.start({ ...START, signal: new AbortController().signal });

    mic.status(false);
    mic.status(false);

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("says the recording ended when it is full, and keeps what fit", async () => {
    const mic = fakeStream();
    const { adapter, onEnded } = adapterFor(mic.stream);
    const capture = await adapter.start({ maxBytes: 44 + 4, signal: new AbortController().signal });

    mic.deliver([1, 2]);
    mic.deliver([3]);

    expect(onEnded).toHaveBeenCalledTimes(1);
    await expect(capture.stop()).resolves.toMatchObject({ size: 48 });
  });

  it("says the recording ended when a buffer cannot be used, and has nothing to send", async () => {
    const mic = fakeStream();
    const { adapter, onEnded } = adapterFor(mic.stream);
    const capture = await adapter.start({ ...START, signal: new AbortController().signal });

    mic.deliver([1, 2]);
    mic.deliverRaw({ data: new Uint8Array(3).buffer, sampleRate: 16_000, channels: 1 });

    expect(onEnded).toHaveBeenCalledTimes(1);
    await expect(capture.stop()).rejects.toMatchObject({ safeMessage: "This recording cannot be transcribed" });
  });

  it("ignores buffers that arrive after it was stopped", async () => {
    const mic = fakeStream();
    const { adapter } = adapterFor(mic.stream);
    const onLevel = jest.fn();
    const capture = await adapter.start({ ...START, signal: new AbortController().signal, onLevel });
    mic.deliver([5]);
    // The listener as subscribed: a native event already on its way still reaches it.
    const listener = jest.mocked(mic.stream.onBuffer).mock.calls[0]![0];

    await capture.stop();
    listener({ data: new Int16Array([6]).buffer, sampleRate: 16_000, channels: 1 });

    expect(onLevel).toHaveBeenCalledTimes(1);
  });

  it("still stops when letting go of the microphone throws", async () => {
    const mic = fakeStream({ stop: jest.fn(() => { throw new Error("native stop failed"); }) });
    const { adapter } = adapterFor(mic.stream);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const capture = await adapter.start({ ...START, signal: new AbortController().signal });
    mic.deliver([7, 8]);

    await expect(capture.stop()).resolves.toMatchObject({ type: "audio/wav", size: 48 });
    expect(warn).toHaveBeenCalledWith("[speech] microphone cleanup failed", "Error");
    warn.mockRestore();
  });
});
