const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = pcm.length / 2;
  const output = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    let sample = pcm.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > MULAW_CLIP) sample = MULAW_CLIP;
    sample += MULAW_BIAS;
    let exponent = 7;
    for (
      let expMask = 0x4000;
      (sample & expMask) === 0 && exponent > 0;
      exponent--, expMask >>= 1
    ) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    output[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return output;
}

export function mulawToPcm(mulaw: Buffer): Buffer {
  const output = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    const byte = ~mulaw[i]! & 0xff;
    const sign = byte & 0x80;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    if (sign) sample = -sample;
    output.writeInt16LE(sample, i * 2);
  }
  return output;
}

export function resample(
  pcm: Buffer,
  fromRate: number,
  toRate: number,
): Buffer {
  if (fromRate === toRate) return Buffer.from(pcm);
  const inputSamples = pcm.length / 2;
  const outputSamples = Math.round((inputSamples * toRate) / fromRate);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = (i * fromRate) / toRate;
    const index0 = Math.floor(srcIndex);
    const index1 = Math.min(index0 + 1, inputSamples - 1);
    const fraction = srcIndex - index0;
    const sample0 = pcm.readInt16LE(index0 * 2);
    const sample1 = pcm.readInt16LE(index1 * 2);
    const interpolated = Math.round(sample0 + (sample1 - sample0) * fraction);
    output.writeInt16LE(
      Math.max(-32768, Math.min(32767, interpolated)),
      i * 2,
    );
  }
  return output;
}

export function convertToTelephony(pcm: Buffer, sampleRate: number): Buffer {
  const resampled = resample(pcm, sampleRate, 8000);
  return pcmToMulaw(resampled);
}
