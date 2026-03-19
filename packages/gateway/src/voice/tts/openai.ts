import type { TtsProvider, TtsOptions, TtsResult } from "./base.js";

function estimateMp3Duration(audio: Buffer): number {
  const bytesPerMs = 16;
  return Math.round(audio.length / bytesPerMs);
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly name = "openai";
  private apiKey: string | undefined;
  private defaultModel: string;
  private defaultVoice: string;

  constructor(config?: { apiKey?: string; model?: string; voice?: string }) {
    this.apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
    this.defaultModel = config?.model || "tts-1";
    this.defaultVoice = config?.voice || "alloy";
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        input: text,
        voice: options?.voice || this.defaultVoice,
        response_format: "mp3",
      }),
    });
    if (!response.ok)
      throw new Error(`OpenAI TTS error: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);
    return {
      audio,
      format: "mp3",
      sampleRate: 24000,
      durationMs: estimateMp3Duration(audio),
      provider: this.name,
    };
  }
}
