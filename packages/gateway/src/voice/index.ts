import { FallbackTtsChain } from "./tts/fallback.js";
import { ElevenLabsTtsProvider } from "./tts/elevenlabs.js";
import { OpenAiTtsProvider } from "./tts/openai.js";
import { EdgeTtsProvider } from "./tts/edge-tts.js";
import { WhisperSttProvider } from "./stt/whisper.js";
import { VoiceUsageTracker } from "./usage.js";
import type { TtsOptions, TtsResult } from "./tts/base.js";
import type { SttProvider, SttOptions, SttResult } from "./stt/base.js";

export interface VoiceServiceConfig {
  enabled?: boolean;
  homePath?: string;
  tts?: {
    provider?: string;
    elevenlabs?: { apiKey?: string; voiceId?: string; model?: string };
    openai?: { apiKey?: string; model?: string; voice?: string };
  };
  stt?: {
    provider?: string;
    openai?: { apiKey?: string; model?: string };
  };
}

export class VoiceService {
  readonly tts: FallbackTtsChain | null;
  readonly stt: SttProvider | null;
  readonly usage: VoiceUsageTracker | null;
  private enabled: boolean;

  private constructor(
    tts: FallbackTtsChain | null,
    stt: SttProvider | null,
    enabled: boolean,
    usage: VoiceUsageTracker | null = null,
  ) {
    this.tts = tts;
    this.stt = stt;
    this.enabled = enabled;
    this.usage = usage;
  }

  static create(config: VoiceServiceConfig = {}): VoiceService {
    if (config.enabled === false) {
      return new VoiceService(null, null, false);
    }

    const usageTracker = config.homePath
      ? new VoiceUsageTracker(config.homePath)
      : null;

    const onUsage = usageTracker
      ? (info: { provider: string; chars: number; cost: number }) => {
          usageTracker.track({
            action: "tts",
            provider: info.provider,
            chars: info.chars,
            cost: info.cost,
          });
        }
      : undefined;

    const ttsProviders = [
      new ElevenLabsTtsProvider(config.tts?.elevenlabs),
      new OpenAiTtsProvider(config.tts?.openai),
      new EdgeTtsProvider(),
    ];

    const tts = new FallbackTtsChain(ttsProviders, { onUsage });

    const stt = new WhisperSttProvider(config.stt?.openai);

    const service = new VoiceService(
      tts,
      stt.isAvailable() ? stt : null,
      true,
      usageTracker,
    );

    const availableTts = ttsProviders
      .filter((p) => p.isAvailable())
      .map((p) => p.name);
    const sttAvailable = stt.isAvailable();
    console.log(
      `[voice] TTS providers: ${availableTts.length ? availableTts.join(", ") : "none (edge-tts fallback)"}`,
    );
    console.log(
      `[voice] STT: ${sttAvailable ? "whisper" : "unavailable (no OPENAI_API_KEY)"}`,
    );

    return service;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    if (!this.tts) throw new Error("Voice TTS is not enabled");
    return this.tts.synthesize(text, options);
  }

  async transcribe(audio: Buffer, options?: SttOptions): Promise<SttResult> {
    if (!this.stt)
      throw new Error("Voice STT is not available (no API key configured)");
    return this.stt.transcribe(audio, options);
  }

  health(): {
    enabled: boolean;
    tts: { available: boolean; providers: string[] };
    stt: { available: boolean; provider: string | null };
  } {
    return {
      enabled: this.enabled,
      tts: {
        available: this.tts?.isAvailable() ?? false,
        providers:
          this.tts
            ?.getStatus()
            .filter((s) => s.available)
            .map((s) => s.name) ?? [],
      },
      stt: {
        available: this.stt?.isAvailable() ?? false,
        provider: this.stt ? "whisper" : null,
      },
    };
  }

  stop(): void {
    // Cleanup resources if needed (future: close WebSocket connections, etc.)
  }
}
