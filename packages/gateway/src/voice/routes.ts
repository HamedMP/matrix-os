import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { VoiceService } from "./index.js";
import type { CallStore } from "./call-store.js";

export type VoiceRoutesConfig = {
  voiceService: VoiceService;
  callStore: CallStore;
  homePath: string;
};

const ALLOWED_AUDIO_FORMATS = new Set(["mp3", "wav", "ogg", "opus", "flac", "webm", "m4a"]);

export function createVoiceRoutes(config: VoiceRoutesConfig): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json(config.voiceService.health());
  });

  app.get("/calls", (c) => {
    const calls = config.callStore.getRecent(50);
    return c.json(calls);
  });

  app.get("/calls/:id", (c) => {
    const id = c.req.param("id");
    const call = config.callStore.getById(id);
    if (!call) {
      return c.json({ error: "Call not found" }, 404);
    }
    return c.json(call);
  });

  app.post("/tts", async (c) => {
    try {
      const body = await c.req.json<{
        text?: string;
        voice?: string;
        provider?: string;
      }>();

      if (!body.text) {
        return c.json({ error: "Text is required" }, 400);
      }
      if (body.text.length > 5000) {
        return c.json({ error: "Text too long (max 5000 chars)" }, 400);
      }

      const result = await config.voiceService.synthesize(body.text, {
        voice: body.voice,
      });

      if (!ALLOWED_AUDIO_FORMATS.has(result.format)) {
        return c.json({ error: "Unsupported audio format" }, 500);
      }

      const audioDir = join(config.homePath, "data", "audio");
      mkdirSync(audioDir, { recursive: true });
      const fileName = `${randomUUID()}.${result.format}`;
      writeFileSync(join(audioDir, fileName), result.audio);

      const audioUrl = `/files/data/audio/${fileName}`;

      return c.json({
        audioUrl,
        durationMs: result.durationMs,
        provider: result.provider,
        format: result.format,
      });
    } catch (e) {
      console.error("[voice/tts]", e instanceof Error ? e.message : String(e));
      return c.json({ error: "TTS synthesis failed" }, 500);
    }
  });

  app.post(
    "/stt",
    bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: "File too large (max 25MB)" }, 413) }),
    async (c) => {
    try {

      const formData = await c.req.formData();
      const audioFile = formData.get("audio");

      if (!audioFile || !(audioFile instanceof File)) {
        return c.json({ error: "Audio file is required" }, 400);
      }

      const arrayBuffer = await audioFile.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      if (audioBuffer.length > 25 * 1024 * 1024) {
        return c.json({ error: "File too large (max 25MB)" }, 413);
      }

      const result = await config.voiceService.transcribe(audioBuffer);

      return c.json({
        text: result.text,
        language: result.language,
        durationMs: result.durationMs,
      });
    } catch (e) {
      console.error("[voice/stt]", e instanceof Error ? e.message : String(e));
      return c.json({ error: "STT transcription failed" }, 500);
    }
  });

  return app;
}
