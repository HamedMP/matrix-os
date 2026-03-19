export type TtsOptions = {
  voice?: string;
  model?: string;
  format?: "mp3" | "pcm" | "opus";
};

export type TtsResult = {
  audio: Buffer;
  format: "mp3" | "pcm" | "opus";
  sampleRate: number;
  durationMs: number;
  provider: string;
};

export interface TtsProvider {
  readonly name: string;
  synthesize(text: string, options?: TtsOptions): Promise<TtsResult>;
  isAvailable(): boolean;
}
