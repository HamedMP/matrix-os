import type { TtsProvider, TtsOptions, TtsResult } from "./base.js";
import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function estimateMp3Duration(audio: Buffer): number {
  const bytesPerMs = 16;
  return Math.round(audio.length / bytesPerMs);
}

export class EdgeTtsProvider implements TtsProvider {
  readonly name = "edge";
  private defaultVoice: string;

  constructor(config?: { voice?: string }) {
    this.defaultVoice = config?.voice || "en-US-AriaNeural";
  }

  isAvailable(): boolean {
    return true;
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const { EdgeTTS } = await import("node-edge-tts");
    const voice = options?.voice || this.defaultVoice;
    const tts = new EdgeTTS({
      voice,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    });
    const tmpPath = join(tmpdir(), `edge-tts-${randomBytes(8).toString("hex")}.mp3`);
    try {
      await tts.ttsPromise(text, tmpPath);
      const buffer = await readFile(tmpPath);
      return {
        audio: buffer,
        format: "mp3",
        sampleRate: 24000,
        durationMs: estimateMp3Duration(buffer),
        provider: this.name,
      };
    } finally {
      await unlink(tmpPath).catch((err: unknown) => {
        console.warn("[edge-tts] Could not remove temporary file:", err instanceof Error ? err.message : String(err));
      });
    }
  }
}
