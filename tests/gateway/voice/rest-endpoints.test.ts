import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createVoiceRoutes } from "../../../packages/gateway/src/voice/routes.js";
import { CallStore } from "../../../packages/gateway/src/voice/call-store.js";
import type { CallRecord } from "../../../packages/gateway/src/voice/types.js";

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: `call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    provider: "mock",
    direction: "outbound",
    state: "initiated",
    from: "+1234567890",
    to: "+0987654321",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    mode: "conversation",
    ...overrides,
  };
}

describe("Voice REST Endpoints", () => {
  let app: Hono;
  let tempDir: string;
  let callStore: CallStore;

  beforeEach(() => {
    tempDir = resolve(mkdtempSync(join(tmpdir(), "voice-rest-")));
    mkdirSync(join(tempDir, "voice"), { recursive: true });
    mkdirSync(join(tempDir, "data", "audio"), { recursive: true });

    callStore = new CallStore(join(tempDir, "voice", "calls.jsonl"));

    const voiceService = {
      isEnabled: () => true,
      health: () => ({
        enabled: true,
        tts: { available: true, providers: ["edge"] },
        stt: { available: false, provider: null },
      }),
      synthesize: vi.fn().mockResolvedValue({
        audio: Buffer.from("fake-audio"),
        format: "mp3",
        sampleRate: 24000,
        durationMs: 1500,
        provider: "edge",
      }),
      transcribe: vi.fn().mockResolvedValue({
        text: "hello world",
        language: "en",
        durationMs: 2000,
      }),
    };

    const routes = createVoiceRoutes({
      voiceService: voiceService as any,
      callStore,
      homePath: tempDir,
    });

    app = new Hono();
    app.route("/api/voice", routes);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("GET /api/voice/health", () => {
    it("returns voice service health status", async () => {
      const res = await app.request("/api/voice/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.tts.available).toBe(true);
      expect(body.stt.available).toBe(false);
    });
  });

  describe("GET /api/voice/calls", () => {
    it("returns recent calls from store", async () => {
      callStore.append(makeRecord({ callId: "call-1" }));
      callStore.append(makeRecord({ callId: "call-2" }));
      callStore.append(makeRecord({ callId: "call-3" }));

      const res = await app.request("/api/voice/calls");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.length).toBe(3);
    });

    it("returns empty array when no calls", async () => {
      const res = await app.request("/api/voice/calls");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual([]);
    });
  });

  describe("GET /api/voice/calls/:id", () => {
    it("returns specific call record", async () => {
      callStore.append(makeRecord({ callId: "target-call" }));

      const res = await app.request("/api/voice/calls/target-call");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.callId).toBe("target-call");
    });

    it("returns 404 for unknown call", async () => {
      const res = await app.request("/api/voice/calls/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/voice/tts", () => {
    it("synthesizes speech and returns audio URL", async () => {
      const res = await app.request("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello world" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.audioUrl).toBeDefined();
      expect(body.durationMs).toBe(1500);
      expect(body.provider).toBe("edge");
    });

    it("rejects empty text", async () => {
      const res = await app.request("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/voice/stt", () => {
    it("transcribes audio and returns text", async () => {
      const form = new FormData();
      const blob = new Blob([Buffer.from("fake-audio")], {
        type: "audio/webm",
      });
      form.append("audio", blob, "recording.webm");

      const res = await app.request("/api/voice/stt", {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.text).toBe("hello world");
      expect(body.language).toBe("en");
    });
  });
});
