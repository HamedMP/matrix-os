import { assertAudio, trimAudio, compressDynamics, reduceNoise, changePitchAndSpeed, encodeWav } from "./audio-tools.mjs";

self.onmessage = (event) => {
  try {
    const { audio, slug, options } = event.data;
    assertAudio(audio);
    let result = audio;
    if (["audio-trimmer", "audio-workspace"].includes(slug)) result = trimAudio(result, options.start, options.end);
    if (["noise-reducer", "audio-workspace"].includes(slug) && options.denoise) result = reduceNoise(result, { noiseSeconds: options.noiseSeconds, strength: options.strength });
    if (["audio-workspace"].includes(slug) && options.dynamics) result = compressDynamics(result, { thresholdDb: options.thresholdDb, ratio: options.ratio });
    if (["pitch-and-speed", "audio-workspace"].includes(slug)) result = changePitchAndSpeed(result, { speed: options.speed, semitones: options.semitones });
    const bytes = encodeWav(result);
    self.postMessage({ ok: true, audio: result, bytes }, [bytes.buffer, ...result.channels.map((channel) => channel.buffer)]);
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "Could not process this audio." });
  }
};
