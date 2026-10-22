import { encodePcm16WavBytes, PlatformSpeechRecorderError } from "@matrix-os/ui/speech";

/** Dictation is sent at the rate the web app records at. */
export const SPEECH_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;
const MIN_INPUT_RATE = 8_000;
const MAX_INPUT_RATE = 96_000;
const MAX_CHANNELS = 8;
// About ten buffers a second for the two minutes a recording may last, with room to spare.
const MAX_CHUNKS = 4_096;

/** One buffer of 16-bit little-endian PCM from the microphone, channels interleaved. */
export interface PcmBuffer {
  data: ArrayBuffer;
  sampleRate: number;
  channels: number;
}

export interface PcmAppendResult {
  /** The buffer's loudness as root mean square, 0 (silence) to 1. */
  level: number;
  /** The buffer did not fit under the size limit and was left out: the recording is full. */
  full: boolean;
}

function invalidBuffer(): PlatformSpeechRecorderError {
  return new PlatformSpeechRecorderError("This recording cannot be transcribed");
}

/**
 * Collects a recording as 16 kHz mono samples, whatever the microphone
 * delivers, within a size limit, and packs it as a WAV. Samples stay in memory
 * only until the recording is finished or cleared.
 *
 * Both platforms normally deliver 16 kHz mono already. A device that cannot is
 * brought down by linear interpolation, which keeps a two-minute recording well
 * under the limit.
 */
export class SpeechPcmCollector {
  private chunks: Int16Array[] = [];
  private bytes = 0;
  private inputRate = 0;
  // Where the next output sample falls, in input samples from the start of the
  // next buffer. Below 0 it falls between the last buffer's final sample and
  // the next buffer's first.
  private position = 0;
  private previous = 0;

  constructor(private readonly maxBytes: number) {}

  append(buffer: PcmBuffer): PcmAppendResult {
    const { data, sampleRate, channels } = buffer;
    if (!Number.isInteger(sampleRate) || sampleRate < MIN_INPUT_RATE || sampleRate > MAX_INPUT_RATE
      || !Number.isInteger(channels) || channels < 1 || channels > MAX_CHANNELS
      || data.byteLength % (channels * 2) !== 0) {
      throw invalidBuffer();
    }
    const mono = this.downmix(data, channels);
    const level = rootMeanSquare(mono);
    if (sampleRate !== this.inputRate) {
      this.inputRate = sampleRate;
      this.position = 0;
    }
    const output = sampleRate === SPEECH_SAMPLE_RATE ? mono : this.resample(mono, sampleRate);
    if (output.length === 0) return { level, full: false };
    if (this.chunks.length >= MAX_CHUNKS || this.bytes + output.byteLength > this.maxBytes - WAV_HEADER_BYTES) {
      return { level, full: true };
    }
    this.chunks.push(output);
    this.bytes += output.byteLength;
    return { level, full: false };
  }

  /** The recording as a WAV file. Clears what was collected. */
  finish(): Uint8Array {
    try {
      // Throws a safe "This recording is empty" when nothing was collected.
      return encodePcm16WavBytes(this.chunks, SPEECH_SAMPLE_RATE);
    } finally {
      this.clear();
    }
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
    this.position = 0;
    this.previous = 0;
  }

  private downmix(data: ArrayBuffer, channels: number): Int16Array {
    const view = new DataView(data);
    const frames = data.byteLength / (channels * 2);
    const mono = new Int16Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        sum += view.getInt16((frame * channels + channel) * 2, true);
      }
      mono[frame] = Math.round(sum / channels);
    }
    return mono;
  }

  private resample(input: Int16Array, sampleRate: number): Int16Array {
    const step = sampleRate / SPEECH_SAMPLE_RATE;
    const last = input.length - 1;
    const output: number[] = [];
    let position = this.position;
    while (position <= last) {
      const index = Math.floor(position);
      const fraction = position - index;
      const before = index < 0 ? this.previous : input[index]!;
      if (fraction === 0) {
        output.push(before);
      } else {
        if (index + 1 > last) break;
        output.push(Math.round(before + (input[index + 1]! - before) * fraction));
      }
      position += step;
    }
    this.position = position - input.length;
    if (input.length > 0) this.previous = input[last]!;
    return Int16Array.from(output);
  }
}

function rootMeanSquare(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const value = sample / 32_768;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}
