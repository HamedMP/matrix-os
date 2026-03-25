export type SttOptions = {
  language?: string;
  model?: string;
};

export type SttResult = {
  text: string;
  language: string;
  durationMs: number;
  confidence?: number;
};

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, options?: SttOptions): Promise<SttResult>;
  isAvailable(): boolean;
}
