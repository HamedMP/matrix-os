import type { TtsProvider, TtsOptions, TtsResult } from "./base.js";

function estimateMp3Duration(audio: Buffer): number {
  // Rough estimate: MP3 at 128kbps = 16KB/s
  const bytesPerMs = 16;
  return Math.round(audio.length / bytesPerMs);
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";
  private apiKey: string | undefined;
  private defaultVoiceId: string;
  private defaultModel: string;

  constructor(config?: { apiKey?: string; voiceId?: string; model?: string }) {
    this.apiKey = config?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.defaultVoiceId = config?.voiceId || "JBFqnCBsd6RMkjVDRZzb";
    this.defaultModel = config?.model || "eleven_multilingual_v2";
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const voiceId = options?.voice || this.defaultVoiceId;
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: options?.model || this.defaultModel,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`ElevenLabs TTS error: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);
    return {
      audio,
      format: "mp3",
      sampleRate: 44100,
      durationMs: estimateMp3Duration(audio),
      provider: this.name,
    };
  }
}
