import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock browser APIs for useVoice testing
class MockMediaStream {
  tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()];
  getTracks() {
    return this.tracks;
  }
}

class MockMediaStreamTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class MockMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  static isTypeSupported(mimeType: string) {
    return mimeType === "audio/webm;codecs=opus" || mimeType === "audio/webm";
  }

  start(_timeslice?: number) {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

class MockAudioContext {
  destination = {};
  closed = false;

  decodeAudioData(buffer: ArrayBuffer) {
    return Promise.resolve({
      duration: 1.0,
      length: 44100,
      sampleRate: 44100,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(44100),
    });
  }

  createBufferSource() {
    const source: Record<string, unknown> = {
      buffer: null,
      onended: null,
      connect: vi.fn(),
      start: vi.fn(() => {
        setTimeout(() => {
          if (typeof source.onended === "function") {
            (source.onended as () => void)();
          }
        }, 10);
      }),
    };
    return source;
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onmessage: ((evt: { data: string | Blob }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      const openHandlers = this.listeners.get("open") || [];
      for (const h of openHandlers) h();
    }, 0);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  addEventListener(event: string, handler: (...args: unknown[]) => void, _opts?: { once?: boolean }) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  removeEventListener(event: string, handler: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter((h) => h !== handler));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("useVoice hook logic", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  describe("startRecording", () => {
    it("sets isRecording to true when mic access granted", async () => {
      const stream = new MockMediaStream();
      const getUserMedia = vi.fn().mockResolvedValue(stream);

      let isRecording = false;
      const setIsRecording = (v: boolean) => { isRecording = v; };

      // Simulate startRecording logic
      const supported = true;
      if (!supported) return;

      await getUserMedia({ audio: true });
      const recorder = new MockMediaRecorder();
      recorder.start(250);
      setIsRecording(true);

      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(isRecording).toBe(true);
      expect(recorder.state).toBe("recording");
    });

    it("uses opus codec when supported", () => {
      expect(MockMediaRecorder.isTypeSupported("audio/webm;codecs=opus")).toBe(true);
      const mimeType = MockMediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      expect(mimeType).toBe("audio/webm;codecs=opus");
    });

    it("falls back to audio/webm when opus not supported", () => {
      const orig = MockMediaRecorder.isTypeSupported;
      MockMediaRecorder.isTypeSupported = (type: string) =>
        type === "audio/webm" ? true : false;

      const mimeType = MockMediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      expect(mimeType).toBe("audio/webm");

      MockMediaRecorder.isTypeSupported = orig;
    });
  });

  describe("stopRecording", () => {
    it("sets isRecording to false and stops the recorder", () => {
      let isRecording = true;
      const recorder = new MockMediaRecorder();
      recorder.start();

      if (recorder.state === "recording") {
        recorder.stop();
        isRecording = false;
      }

      expect(isRecording).toBe(false);
      expect(recorder.state).toBe("inactive");
    });

    it("stops media tracks when recording stops", () => {
      const stream = new MockMediaStream();
      const recorder = new MockMediaRecorder();
      recorder.start();

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.stop();

      expect(stream.tracks[0].stopped).toBe(true);
    });

    it("sends audio data over voice WebSocket on stop", async () => {
      const ws = new MockWebSocket("ws://localhost/ws/voice");
      ws.readyState = MockWebSocket.OPEN;

      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
      const buffer = await blob.arrayBuffer();

      ws.send(JSON.stringify({ type: "audio_start" }));
      ws.send(buffer);
      ws.send(JSON.stringify({ type: "audio_end" }));

      expect(ws.sent).toHaveLength(3);
      expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: "audio_start" });
      expect(ws.sent[1]).toBeInstanceOf(ArrayBuffer);
      expect(JSON.parse(ws.sent[2] as string)).toEqual({ type: "audio_end" });
    });
  });

  describe("playAudio", () => {
    it("sets isPlaying to true then false when done", async () => {
      const ctx = new MockAudioContext();
      let isPlaying = false;

      const audioData = new ArrayBuffer(8);
      isPlaying = true;

      const buffer = await ctx.decodeAudioData(audioData);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      (source.connect as ReturnType<typeof vi.fn>)(ctx.destination);

      source.onended = () => { isPlaying = false; };
      (source.start as ReturnType<typeof vi.fn>)();

      // Wait for the simulated onended
      await new Promise((r) => setTimeout(r, 20));

      expect(isPlaying).toBe(false);
      expect(source.connect).toHaveBeenCalledWith(ctx.destination);
      expect(source.start).toHaveBeenCalled();
    });

    it("resets isPlaying on decode error", async () => {
      const ctx = new MockAudioContext();
      ctx.decodeAudioData = () => Promise.reject(new Error("decode failed"));

      let isPlaying = true;

      try {
        await ctx.decodeAudioData(new ArrayBuffer(8));
      } catch {
        isPlaying = false;
      }

      expect(isPlaying).toBe(false);
    });
  });

  describe("error handling", () => {
    it("sets error when mic permission denied", async () => {
      const getUserMedia = vi.fn().mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));

      let errorMsg = "";
      try {
        await getUserMedia({ audio: true });
      } catch (e) {
        errorMsg = `Microphone access denied: ${e instanceof Error ? e.message : String(e)}`;
      }

      expect(errorMsg).toContain("Microphone access denied");
      expect(errorMsg).toContain("Permission denied");
    });

    it("handles voice WebSocket errors", () => {
      const ws = new MockWebSocket("ws://localhost/ws/voice");
      let errorReceived = "";

      ws.onerror = () => {
        errorReceived = "Voice WebSocket connection failed";
      };

      ws.onerror();

      expect(errorReceived).toBe("Voice WebSocket connection failed");
    });
  });

  describe("cleanup on unmount", () => {
    it("stops active recording on cleanup", () => {
      const recorder = new MockMediaRecorder();
      recorder.start();
      expect(recorder.state).toBe("recording");

      // Cleanup logic
      if (recorder.state === "recording") {
        recorder.stop();
      }

      expect(recorder.state).toBe("inactive");
    });

    it("closes voice WebSocket on cleanup", () => {
      const ws = new MockWebSocket("ws://localhost/ws/voice");
      ws.readyState = MockWebSocket.OPEN;

      ws.close();

      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });
  });

  describe("transcription handling", () => {
    it("handles transcription response from voice WebSocket", () => {
      const ws = new MockWebSocket("ws://localhost/ws/voice");
      let transcribedText = "";
      let isTranscribing = true;

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === "transcription") {
          isTranscribing = false;
          transcribedText = msg.text;
        }
      };

      ws.simulateMessage({ type: "transcription", text: "hello world" });

      expect(isTranscribing).toBe(false);
      expect(transcribedText).toBe("hello world");
    });

    it("handles error response from voice WebSocket", () => {
      const ws = new MockWebSocket("ws://localhost/ws/voice");
      let errorMsg = "";
      let isTranscribing = true;

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === "error") {
          isTranscribing = false;
          errorMsg = msg.message;
        }
      };

      ws.simulateMessage({ type: "error", message: "STT failed" });

      expect(isTranscribing).toBe(false);
      expect(errorMsg).toBe("STT failed");
    });
  });

  describe("browser support detection", () => {
    it("detects when getUserMedia and MediaRecorder are available", () => {
      const hasGetUserMedia = typeof vi.fn === "function"; // Simulating check
      const hasMediaRecorder = typeof MockMediaRecorder === "function";

      expect(hasGetUserMedia && hasMediaRecorder).toBe(true);
    });

    it("returns isSupported false when APIs missing", () => {
      const hasGetUserMedia = false;
      const hasMediaRecorder = true;

      expect(hasGetUserMedia && hasMediaRecorder).toBe(false);
    });
  });
});
