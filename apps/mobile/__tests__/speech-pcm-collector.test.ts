import { PlatformSpeechRecorderError } from "@matrix-os/ui/speech";

import { SPEECH_SAMPLE_RATE, SpeechPcmCollector } from "../lib/speech/pcm-collector";

const WAV_HEADER_BYTES = 44;

function int16Buffer(samples: readonly number[], sampleRate = SPEECH_SAMPLE_RATE, channels = 1) {
  return { data: new Int16Array(samples).buffer, sampleRate, channels };
}

function wavInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return {
    riff: tag(0),
    wave: tag(8),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
    samples: Array.from({ length: view.getUint32(40, true) / 2 }, (_, index) => view.getInt16(WAV_HEADER_BYTES + index * 2, true)),
  };
}

describe("SpeechPcmCollector", () => {
  it("keeps 16 kHz mono samples as they are and packs them as a 16-bit mono WAV", () => {
    const collector = new SpeechPcmCollector(1_000);
    collector.append(int16Buffer([100, -200, 300]));
    collector.append(int16Buffer([-400]));

    const wav = wavInfo(collector.finish());

    expect(wav).toMatchObject({ riff: "RIFF", wave: "WAVE", channels: 1, sampleRate: 16_000, bitsPerSample: 16, dataBytes: 8 });
    expect(wav.samples).toEqual([100, -200, 300, -400]);
  });

  it("mixes several channels down to one", () => {
    const collector = new SpeechPcmCollector(1_000);
    collector.append(int16Buffer([1_000, 3_000, -2_000, 0], SPEECH_SAMPLE_RATE, 2));

    expect(wavInfo(collector.finish()).samples).toEqual([2_000, -1_000]);
  });

  it("brings a faster microphone down to 16 kHz, across buffer boundaries", () => {
    const collector = new SpeechPcmCollector(100_000);
    // 48 kHz: every third input sample is one output sample.
    const ramp = Array.from({ length: 300 }, (_, index) => index * 10);
    collector.append(int16Buffer(ramp.slice(0, 100), 48_000));
    collector.append(int16Buffer(ramp.slice(100), 48_000));

    const { sampleRate, samples } = wavInfo(collector.finish());

    expect(sampleRate).toBe(16_000);
    expect(samples).toEqual(Array.from({ length: 100 }, (_, index) => index * 30));
  });

  it("interpolates a rate that does not divide evenly", () => {
    const collector = new SpeechPcmCollector(100_000);
    // 24 kHz -> 16 kHz takes a sample every 1.5 input samples.
    collector.append(int16Buffer([0, 100, 200, 300, 400, 500], 24_000));

    expect(wavInfo(collector.finish()).samples).toEqual([0, 150, 300, 450]);
  });

  it("reports each buffer's loudness between 0 and 1", () => {
    const collector = new SpeechPcmCollector(1_000);

    expect(collector.append(int16Buffer([0, 0, 0])).level).toBe(0);
    expect(collector.append(int16Buffer([32_767, -32_768])).level).toBeCloseTo(1, 3);
  });

  it("says it is full, and keeps what it has, when the next buffer would pass the size limit", () => {
    // Room for the header and four samples.
    const collector = new SpeechPcmCollector(WAV_HEADER_BYTES + 8);

    expect(collector.append(int16Buffer([1, 2, 3])).full).toBe(false);
    expect(collector.append(int16Buffer([4, 5])).full).toBe(true);
    expect(wavInfo(collector.finish()).samples).toEqual([1, 2, 3]);
  });

  it.each([
    ["an odd number of bytes", { data: new Uint8Array(3).buffer, sampleRate: 16_000, channels: 1 }],
    ["a sample rate it cannot use", { data: new Int16Array(4).buffer, sampleRate: 4_000, channels: 1 }],
    ["no channels", { data: new Int16Array(4).buffer, sampleRate: 16_000, channels: 0 }],
    ["bytes that do not fill whole frames", { data: new Int16Array(3).buffer, sampleRate: 16_000, channels: 2 }],
  ])("refuses a buffer with %s", (_name, buffer) => {
    const collector = new SpeechPcmCollector(1_000);

    expect(() => collector.append(buffer)).toThrow(PlatformSpeechRecorderError);
  });

  it("has nothing to send when nothing was recorded", () => {
    expect(() => new SpeechPcmCollector(1_000).finish()).toThrow(PlatformSpeechRecorderError);
  });

  it("forgets everything once cleared", () => {
    const collector = new SpeechPcmCollector(1_000);
    collector.append(int16Buffer([1, 2, 3]));
    collector.clear();

    expect(() => collector.finish()).toThrow(PlatformSpeechRecorderError);
  });
});
