import { encodePcm16WavBytes } from '@matrix-os/ui/speech';
/** Bounded native int16 PCM collector. Hardware format is authoritative. */
export class NativeSpeechPcm {
  private chunks: Int16Array[] = [];
  private bytes = 0;
  private rate = 0;
  private channels = 0;
  private invalid = false;
  constructor(private readonly maxBytes: number) {}
  append(input: { data: ArrayBuffer; sampleRate: number; channels: number }): number {
    const { data, sampleRate, channels } = input;
    if (this.invalid || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000
      || !Number.isInteger(channels) || channels < 1 || channels > 8
      || data.byteLength % (channels * 2) !== 0 || this.chunks.length >= 24000
      || this.bytes + data.byteLength + 44 > this.maxBytes
      || (this.rate !== 0 && (this.rate !== sampleRate || this.channels !== channels))) {
      this.invalid = true;
      this.clear();
      throw new Error('Recording unavailable');
    }
    this.rate = sampleRate;
    this.channels = channels;
    const view = new DataView(data);
    const chunk = new Int16Array(data.byteLength / (channels * 2));
    for (let frame = 0; frame < chunk.length; frame++) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel++) sum += view.getInt16((frame * channels + channel) * 2, true);
      chunk[frame] = Math.round(sum / channels);
    }
    this.chunks.push(chunk);
    this.bytes += data.byteLength;
    let sum = 0;
    for (let i = 0; i < data.byteLength; i += 2) sum += (view.getInt16(i, true) / 32768) ** 2;
    return data.byteLength ? Math.min(1, Math.sqrt(sum / (data.byteLength / 2))) : 0;
  }
  finish(): Uint8Array {
    if (this.invalid || this.bytes === 0) throw new Error('Recording unavailable');
    const wav = encodePcm16WavBytes(this.chunks, this.rate);
    this.clear();
    return wav;
  }
  clear(): void { this.chunks = []; this.bytes = 0; }
}
