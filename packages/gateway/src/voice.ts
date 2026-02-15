import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface VoiceConfig {
  enabled: boolean;
  elevenlabsKey: string;
  voiceId: string;
  model: string;
  sttProvider: string;
}

export interface TtsResult {
  audio: Buffer;
  localPath: string;
  cost: number;
}

export interface SttResult {
  text: string;
  confidence: number;
  cost: number;
}

export interface VoiceService {
  textToSpeech(text: string, opts?: { voiceId?: string }): Promise<TtsResult>;
  speechToText(audioBuffer: Buffer): Promise<SttResult>;
  isConfigured(): boolean;
}

interface VoiceServiceOptions {
  fetchFn?: typeof fetch;
}

const TTS_COST_PER_CHAR = 0.0003;
const STT_COST_PER_SECOND = 0.0017;
const ESTIMATED_AUDIO_BYTES_PER_SECOND = 16000;

export function createVoiceService(
  config: VoiceConfig,
  homePath: string,
  opts?: VoiceServiceOptions,
): VoiceService {
  const fetchFn = opts?.fetchFn ?? globalThis.fetch;

  return {
    isConfigured(): boolean {
      return config.enabled && Boolean(config.elevenlabsKey);
    },

    async textToSpeech(text: string, ttsOpts?: { voiceId?: string }): Promise<TtsResult> {
      if (!this.isConfigured()) {
        throw new Error("Voice not configured. Set voice.elevenlabs_key in config.json.");
      }

      const voiceId = ttsOpts?.voiceId ?? config.voiceId;
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "xi-api-key": config.elevenlabsKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: config.model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid API key. Check voice.elevenlabs_key in config.json.");
        }
        if (response.status === 429) {
          throw new Error("Rate limit exceeded. Try again later.");
        }
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`TTS failed: ${response.status} ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);

      const audioDir = join(homePath, "data", "audio");
      mkdirSync(audioDir, { recursive: true });
      const fileName = `${Date.now()}-tts.mp3`;
      const localPath = join(audioDir, fileName);
      writeFileSync(localPath, audio);

      const cost = text.length * TTS_COST_PER_CHAR;

      return { audio, localPath, cost };
    },

    async speechToText(audioBuffer: Buffer): Promise<SttResult> {
      if (!this.isConfigured()) {
        throw new Error("Voice not configured. Set voice.elevenlabs_key in config.json.");
      }

      const url = "https://api.elevenlabs.io/v1/speech-to-text";

      const formData = new FormData();
      const blob = new Blob([audioBuffer], { type: "audio/webm" });
      formData.append("audio", blob, "recording.webm");
      formData.append("model_id", "scribe_v1");

      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "xi-api-key": config.elevenlabsKey,
        },
        body: formData,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid API key. Check voice.elevenlabs_key in config.json.");
        }
        if (response.status === 429) {
          throw new Error("Rate limit exceeded. Try again later.");
        }
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`STT failed: ${response.status} ${errorText}`);
      }

      const data = await response.json() as { text: string; confidence?: number };
      const estimatedSeconds = audioBuffer.length / ESTIMATED_AUDIO_BYTES_PER_SECOND;
      const cost = estimatedSeconds * STT_COST_PER_SECOND;

      return {
        text: data.text,
        confidence: data.confidence ?? 0.9,
        cost,
      };
    },
  };
}
