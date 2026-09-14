jest.mock('@matrix-os/contracts', () => jest.requireActual('../../../packages/contracts/src/speech'));
import { NativeSpeechPcm } from '../lib/speech/pcm';

describe('native speech PCM', () => {
  it('downmixes channels while preserving actual device rate into bounded PCM WAV', () => {
    const pcm = new NativeSpeechPcm(100);
    pcm.append({ data: new Int16Array([0, 32767, -32768, 0]).buffer, sampleRate: 48000, channels: 2 });
    const wav = pcm.finish();
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(48);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(4);
  });
  it('rejects overflow and format changes without retaining extra audio', () => {
    const pcm = new NativeSpeechPcm(48);
    pcm.append({ data: new Int16Array([1, 2]).buffer, sampleRate: 16000, channels: 1 });
    expect(() => pcm.append({ data: new Int16Array([1]).buffer, sampleRate: 16000, channels: 1 })).toThrow();
    expect(() => pcm.finish()).toThrow();
  });
  it('rejects empty recording and invalid metadata', () => {
    expect(() => new NativeSpeechPcm(100).finish()).toThrow();
    expect(() => new NativeSpeechPcm(100).append({ data: new ArrayBuffer(3), sampleRate: 16000, channels: 1 })).toThrow();
  });
  it('returns finite normalized level and drops samples on cancellation', () => {
    const pcm = new NativeSpeechPcm(100);
    expect(pcm.append({ data: new Int16Array([0, 0]).buffer, sampleRate: 16000, channels: 1 })).toBe(0);
    expect(pcm.append({ data: new Int16Array([32767]).buffer, sampleRate: 16000, channels: 1 })).toBeGreaterThan(0.9);
    pcm.clear();
    expect(() => pcm.finish()).toThrow();
  });
});
