/**
 * Matrix IPC Memory and media generation tools.
 *
 * Extracted from ./ipc-server.ts (Phase 1-A4). Pure move: no logic changes.
 * Each builder receives the shared tool factory so the SDK stays
 * dynamically imported exactly once by the composition root.
 */

import type { tool as createSdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { MatrixDB } from './db.js';
import { createImageClient } from "./image-gen.js";
import { createMemoryStore } from "./memory.js";
import { createUsageTracker } from "./usage.js";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod/v4";

export interface IpcToolDeps {
  db: MatrixDB;
  homePath?: string;
}

type SdkToolFactory = typeof createSdkTool;

export function createMemoryMediaTools(
  deps: IpcToolDeps,
  tool: SdkToolFactory,
) {
  const { db, homePath } = deps;
  return [
        tool(
          "remember",
          "Store a memory about the user. Use when user says 'remember that...', 'I prefer...', 'my X is Y', or states a fact worth remembering.",
          {
            content: z.string().describe("The fact or preference to remember"),
            category: z.enum(["preference", "fact", "context", "instruction"]).optional().describe("Memory category (default: fact)"),
          },
          async ({ content, category }) => {
            const store = createMemoryStore(db);
            const id = store.remember(content, { category });
            return {
              content: [{ type: "text" as const, text: `Remembered: "${content}" (${id})` }],
            };
          },
        ),
  
        tool(
          "recall",
          "Search stored memories. Use when the kernel needs context that might have been stored before.",
          {
            query: z.string().describe("Search query to find relevant memories"),
            limit: z.number().optional().describe("Max results (default: 10)"),
            category: z.enum(["preference", "fact", "context", "instruction"]).optional().describe("Filter by category"),
          },
          async ({ query, limit, category }) => {
            const store = createMemoryStore(db);
            const results = store.recall(query, { limit, category });
            return {
              content: [{
                type: "text" as const,
                text: results.length > 0
                  ? JSON.stringify(results, null, 2)
                  : "No matching memories found",
              }],
            };
          },
        ),
  
        tool(
          "forget",
          "Remove a specific memory. Use when user says 'forget that', 'that's no longer true'.",
          {
            id: z.string().describe("The memory ID to remove"),
          },
          async ({ id }) => {
            const store = createMemoryStore(db);
            store.forget(id);
            return {
              content: [{ type: "text" as const, text: `Forgot memory: ${id}` }],
            };
          },
        ),
  
        tool(
          "list_memories",
          "List all stored memories. Use when user asks 'what do you remember about me?'",
          {
            category: z.enum(["preference", "fact", "context", "instruction"]).optional().describe("Filter by category"),
          },
          async ({ category }) => {
            const store = createMemoryStore(db);
            const results = store.listAll({ category });
            return {
              content: [{
                type: "text" as const,
                text: results.length > 0
                  ? JSON.stringify(results, null, 2)
                  : "No memories stored yet",
              }],
            };
          },
        ),
  
        tool(
          "generate_image",
          "Generate an image from a text description using Nano Banana (Gemini). Saves to ~/data/images/. Returns the local file path.",
          {
            prompt: z.string().describe("Text description of the image to generate"),
            model: z.enum(["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"]).optional().describe("Model to use (default: gemini-2.5-flash-image for speed, 3.1-flash-image-preview for quality, 3-pro-image-preview for professional assets)"),
            aspect_ratio: z.string().optional().describe("Aspect ratio (e.g. 1:1, 16:9, 9:16, 3:2). Default: 1:1"),
            image_size: z.string().optional().describe("Resolution: 512, 1K, 2K, or 4K. Default: 1K"),
            save_as: z.string().optional().describe("Custom filename for the saved image"),
          },
          async ({ prompt, model, aspect_ratio, image_size, save_as }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot generate image (no home path)" }] };
            }
  
            const apiKey = process.env.GEMINI_API_KEY ?? "";
            if (!apiKey) {
              try {
                const configPath = join(homePath, "system", "config.json");
                if (existsSync(configPath)) {
                  const config = JSON.parse(readFileSync(configPath, "utf-8"));
                  if (config.media?.gemini_api_key) {
                    return generateWithKey(config.media.gemini_api_key);
                  }
                }
              } catch (err: unknown) {
                console.warn("[ipc] Could not read image generation config:", err instanceof Error ? err.message : String(err));
              }
              return { content: [{ type: "text" as const, text: "Image generation not configured. Set GEMINI_API_KEY or add media.gemini_api_key to config.json." }] };
            }
  
            return generateWithKey(apiKey);
  
            async function generateWithKey(key: string) {
              const client = createImageClient(key);
              const tracker = createUsageTracker(homePath!);
              const imageDir = join(homePath!, "data", "images");
  
              try {
                const result = await client.generateImage(prompt, {
                  model,
                  aspectRatio: aspect_ratio,
                  imageSize: image_size,
                  imageDir,
                  saveAs: save_as,
                });
  
                tracker.track("image_gen", result.cost, { model: result.model, prompt });
  
                return {
                  content: [{
                    type: "text" as const,
                    text: `Image generated and saved to ${result.localPath}\nModel: ${result.model}\nCost: $${result.cost.toFixed(4)}\n\nTo display: ~/data/images/${result.localPath.split("/").pop()}`,
                  }],
                };
              } catch (e) {
                return {
                  content: [{
                    type: "text" as const,
                    text: `Image generation failed: ${e instanceof Error ? e.message : String(e)}`,
                  }],
                };
              }
            }
          },
        ),
  
        tool(
          "speak",
          "Convert text to speech audio using ElevenLabs. Saves audio to ~/data/audio/. Useful for proactive audio messages.",
          {
            text: z.string().describe("Text to convert to speech"),
            voice_id: z.string().optional().describe("Custom ElevenLabs voice ID"),
          },
          async ({ text, voice_id }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot speak (no home path)" }] };
            }
  
            let voiceConfig: { elevenlabs_key?: string; voice_id?: string; model?: string; enabled?: boolean } = {};
            try {
              const configPath = join(homePath, "system", "config.json");
              if (existsSync(configPath)) {
                const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
                voiceConfig = cfg.voice ?? {};
              }
            } catch (err: unknown) {
              console.warn("[ipc] Could not read voice config:", err instanceof Error ? err.message : String(err));
            }
  
            const apiKey = process.env.ELEVENLABS_API_KEY ?? voiceConfig.elevenlabs_key ?? "";
            if (!apiKey) {
              return { content: [{ type: "text" as const, text: "Voice not configured. Set ELEVENLABS_API_KEY or add voice.elevenlabs_key to config.json." }] };
            }
  
            const vid = voice_id ?? voiceConfig.voice_id ?? "21m00Tcm4TlvDq8ikWAM";
            const model = voiceConfig.model ?? "eleven_turbo_v2_5";
  
            try {
              const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}`;
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  "xi-api-key": apiKey,
                  "Content-Type": "application/json",
                  Accept: "audio/mpeg",
                },
                body: JSON.stringify({
                  text,
                  model_id: model,
                  voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                }),
                signal: AbortSignal.timeout(30_000),
              });
  
              if (!response.ok) {
                return { content: [{ type: "text" as const, text: `TTS failed: ${response.status} ${response.statusText}` }] };
              }
  
              const arrayBuffer = await response.arrayBuffer();
              const audioDir = join(homePath, "data", "audio");
              mkdirSync(audioDir, { recursive: true });
              const fileName = `${Date.now()}-tts.mp3`;
              const localPath = join(audioDir, fileName);
              await writeFile(localPath, Buffer.from(arrayBuffer));
  
              const cost = text.length * 0.0003;
              const tracker = createUsageTracker(homePath);
              tracker.track("voice_tts", cost, { chars: text.length });
  
              return {
                content: [{ type: "text" as const, text: `Audio saved to ${localPath}\nCost: $${cost.toFixed(4)}` }],
              };
            } catch (e) {
              return {
                content: [{ type: "text" as const, text: `TTS error: ${e instanceof Error ? e.message : String(e)}` }],
              };
            }
          },
        ),
  
        tool(
          "transcribe",
          "Convert audio file to text using speech-to-text. Returns transcription.",
          {
            audio_path: z.string().describe("Path to audio file to transcribe"),
          },
          async ({ audio_path }) => {
            if (!homePath) {
              return { content: [{ type: "text" as const, text: "Cannot transcribe (no home path)" }] };
            }
  
            let voiceConfig: { elevenlabs_key?: string; stt_provider?: string } = {};
            try {
              const configPath = join(homePath, "system", "config.json");
              if (existsSync(configPath)) {
                const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
                voiceConfig = cfg.voice ?? {};
              }
            } catch (err: unknown) {
              console.warn("[ipc] Could not read transcription config:", err instanceof Error ? err.message : String(err));
            }
  
            const apiKey = process.env.ELEVENLABS_API_KEY ?? voiceConfig.elevenlabs_key ?? "";
            if (!apiKey) {
              return { content: [{ type: "text" as const, text: "Voice not configured. Set ELEVENLABS_API_KEY or add voice.elevenlabs_key to config.json." }] };
            }
  
            const absPath = audio_path.startsWith("/") ? audio_path : join(homePath, audio_path.replace(/^~\//, ""));
            if (!existsSync(absPath)) {
              return { content: [{ type: "text" as const, text: `Audio file not found: ${absPath}` }] };
            }
  
            try {
              const audioBuffer = readFileSync(absPath);
              const formData = new FormData();
              const blob = new Blob([audioBuffer], { type: "audio/webm" });
              formData.append("audio", blob, "recording.webm");
              formData.append("model_id", "scribe_v1");
  
              const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
                method: "POST",
                headers: { "xi-api-key": apiKey },
                body: formData,
                signal: AbortSignal.timeout(30_000),
              });
  
              if (!response.ok) {
                return { content: [{ type: "text" as const, text: `STT failed: ${response.status} ${response.statusText}` }] };
              }
  
              const data = await response.json() as { text: string };
              const estimatedSeconds = audioBuffer.length / 16000;
              const cost = estimatedSeconds * 0.0017;
              const tracker = createUsageTracker(homePath);
              tracker.track("voice_stt", cost, { audio_path: absPath });
  
              return {
                content: [{ type: "text" as const, text: `Transcription: ${data.text}\nCost: $${cost.toFixed(4)}` }],
              };
            } catch (e) {
              return {
                content: [{ type: "text" as const, text: `STT error: ${e instanceof Error ? e.message : String(e)}` }],
              };
            }
          },
        ),
  ];
}
