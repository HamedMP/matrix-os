import type { SttProvider, SttOptions, SttResult } from "./base.js";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB Whisper limit

function detectAudioFormat(buf: Buffer): { mimeType: string; ext: string } {
  if (buf.length >= 4) {
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return { mimeType: "audio/mpeg", ext: "mp3" };
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { mimeType: "audio/mpeg", ext: "mp3" };
    if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return { mimeType: "audio/ogg", ext: "ogg" };
    if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return { mimeType: "audio/flac", ext: "flac" };
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return { mimeType: "audio/wav", ext: "wav" };
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mimeType: "audio/webm", ext: "webm" };
  }
  if (buf.length >= 8) {
    const ftypOffset = buf.indexOf("ftyp");
    if (ftypOffset >= 0 && ftypOffset <= 8) return { mimeType: "audio/mp4", ext: "m4a" };
  }
  return { mimeType: "audio/webm", ext: "webm" };
}

export class WhisperSttProvider implements SttProvider {
  readonly name = "whisper";
  private apiKey: string | undefined;
  private defaultModel: string;

  constructor(config?: { apiKey?: string; model?: string }) {
    this.apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
    this.defaultModel = config?.model || "whisper-1";
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async transcribe(audio: Buffer, options?: SttOptions): Promise<SttResult> {
    if (audio.length > MAX_FILE_SIZE) {
      throw new Error(
        `Audio file too large: ${(audio.length / 1024 / 1024).toFixed(1)}MB exceeds 25MB Whisper limit`,
      );
    }

    const { mimeType, ext } = detectAudioFormat(audio);
    const formData = new FormData();
    const blob = new Blob([audio], { type: mimeType });
    formData.append("file", blob, `audio.${ext}`);
    formData.append("model", options?.model || this.defaultModel);
    if (options?.language) {
      formData.append("language", options.language);
    }
    formData.append("response_format", "verbose_json");

    const startTime = Date.now();
    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const status = response.status;
      const body = await response.text().catch(() => "");
      if (status === 401)
        throw new Error("Whisper STT auth error: invalid API key");
      if (status === 429)
        throw new Error("Whisper STT rate limited: too many requests");
      throw new Error(`Whisper STT error: ${status} ${body}`);
    }

    const data = (await response.json()) as {
      text: string;
      language?: string;
      duration?: number;
    };
    const durationMs = Date.now() - startTime;

    return {
      text: data.text,
      language: data.language || options?.language || "en",
      durationMs,
      confidence: undefined,
    };
  }
}
