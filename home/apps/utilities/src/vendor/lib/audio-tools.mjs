/** Local PCM operations shared by the audio tools. No audio bytes leave the browser. */
import { reportToolFailure } from "./diagnostics.mjs";

export const MAX_AUDIO_SECONDS = 180;
export const MAX_AUDIO_FILE_BYTES = 80 * 1024 * 1024;
export const MAX_TRANSCRIPTION_SECONDS = 120;
export const MAX_TRANSCRIPTION_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPTION_INPUT_SAMPLES = 12_000_000;
export const MAX_AUDIO_SESSION_FILES = 5;
export const MAX_AUDIO_SESSION_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_AUDIO_SESSION_BYTES = 80 * 1024 * 1024;
export const MAX_AUDIO_SESSION_SAMPLES = 24_000_000;

export function defaultAudioOptions(duration) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_SECONDS) throw new Error("Invalid audio duration.");
  return { start: 0, end: duration, denoise: false, noiseSeconds: Math.min(.5, duration / 4), strength: .75, dynamics: false, thresholdDb: -18, ratio: 4, speed: 1, semitones: 0 };
}

export function planAudioSessionFiles(existing, candidates) {
  if (!Array.isArray(existing) || !Array.isArray(candidates) || !candidates.length) throw new Error("Choose audio files to add.");
  if (existing.length + candidates.length > MAX_AUDIO_SESSION_FILES) throw new Error("Keep up to five files in one audio session.");
  let bytes = 0;
  for (const item of [...existing, ...candidates]) {
    if (!item || typeof item.name !== "string" || !item.name || !Number.isSafeInteger(item.size) || item.size <= 0) throw new Error("Choose valid audio files.");
    if (item.size > MAX_AUDIO_SESSION_FILE_BYTES) throw new Error("Each session file must be 40 MB or smaller.");
    bytes += item.size;
  }
  if (bytes > MAX_AUDIO_SESSION_BYTES) throw new Error("The saved audio session must stay under 80 MB.");
  return candidates;
}

export function planAudioSessionSamples(existing, candidates) {
  if (!Array.isArray(existing) || !Array.isArray(candidates)) throw new Error("Invalid audio session.");
  let samples = 0;
  for (const audio of [...existing, ...candidates]) {
    if (!audio || !Array.isArray(audio.channels) || !audio.channels.length) throw new Error("Invalid audio session.");
    for (const channel of audio.channels) {
      if (!(channel instanceof Float32Array)) throw new Error("Invalid audio session.");
      samples += channel.length;
    }
  }
  if (samples > MAX_AUDIO_SESSION_SAMPLES) throw new Error("This session exceeds the browser memory limit. Remove a long file before adding another.");
  return candidates;
}

export function patchAudioSessionEntry(entries, id, options) {
  if (!Array.isArray(entries) || !entries.some((entry) => entry.id === id)) throw new Error("Audio tab not found.");
  return entries.map((entry) => entry.id === id ? { ...entry, options: { ...entry.options, ...options } } : entry);
}

export function normalizeAudioSessionManifest(value) {
  try {
    if (!value || !Array.isArray(value.entries) || value.entries.length > MAX_AUDIO_SESSION_FILES) throw new Error();
    const ids = new Set(), entries = [];
    let total = 0;
    for (const raw of value.entries) {
      if (!raw || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.id) || ids.has(raw.id)) throw new Error();
      ids.add(raw.id);
      if (typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 200 || !Number.isSafeInteger(raw.size) || raw.size < 1 || raw.size > MAX_AUDIO_SESSION_FILE_BYTES) throw new Error();
      total += raw.size;
      if (!Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > MAX_AUDIO_SECONDS) throw new Error();
      const options = raw.options;
      if (!options || !Object.entries({ start: [0, raw.duration], end: [0, raw.duration], noiseSeconds: [0, raw.duration], strength: [0, 1], thresholdDb: [-60, -3], ratio: [1, 20], speed: [.5, 2], semitones: [-12, 12] }).every(([key, [minimum, maximum]]) => Number.isFinite(options[key]) && options[key] >= minimum && options[key] <= maximum) || options.end <= options.start || typeof options.denoise !== "boolean" || typeof options.dynamics !== "boolean") throw new Error();
      entries.push({ id: raw.id, name: raw.name, size: raw.size, duration: raw.duration, options: { ...options } });
    }
    if (total > MAX_AUDIO_SESSION_BYTES || (value.activeId !== null && value.activeId !== undefined && !ids.has(value.activeId))) throw new Error();
    return { activeId: value.activeId ?? null, entries };
  } catch (error) {
    reportToolFailure(error);
    throw new Error("Saved audio session is invalid.");
  }
}

export function assertAudio(audio) {
  if (!audio || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 192000 || !Array.isArray(audio.channels) || audio.channels.length < 1 || audio.channels.length > 2) throw new Error("Invalid decoded audio.");
  const count = audio.channels[0]?.length;
  if (!count) throw new Error("This audio file is empty.");
  if (count / audio.sampleRate > MAX_AUDIO_SECONDS) throw new Error("Audio must be three minutes or shorter.");
  for (const channel of audio.channels) {
    if (!(channel instanceof Float32Array) || channel.length !== count) throw new Error("Invalid decoded audio channels.");
    for (const sample of channel) if (!Number.isFinite(sample)) throw new Error("Invalid audio sample found.");
  }
  return count / audio.sampleRate;
}

export function trimAudio(audio, startSeconds, endSeconds) {
  const duration = assertAudio(audio);
  const start = Number(startSeconds), end = Number(endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 1 / audio.sampleRate || end <= start) throw new Error("The end must be after the start and within the audio duration.");
  const first = Math.round(start * audio.sampleRate), last = Math.min(audio.channels[0].length, Math.round(end * audio.sampleRate));
  if (last <= first) throw new Error("Select at least one audio sample.");
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((channel) => channel.slice(first, last)) };
}

export function compressDynamics(audio, options = {}) {
  assertAudio(audio);
  const thresholdDb = Number(options.thresholdDb ?? -18), ratio = Number(options.ratio ?? 4);
  if (!Number.isFinite(thresholdDb) || thresholdDb < -60 || thresholdDb > -3) throw new Error("Threshold must be between -60 and -3 dB.");
  if (!Number.isFinite(ratio) || ratio < 1 || ratio > 20) throw new Error("Ratio must be between 1 and 20.");
  const threshold = 10 ** (thresholdDb / 20);
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((channel) => Float32Array.from(channel, (sample) => {
    const magnitude = Math.abs(sample);
    return Math.sign(sample) * (magnitude <= threshold ? magnitude : threshold * (magnitude / threshold) ** (1 / ratio));
  })) };
}

function fft(real, imaginary, inverse = false) {
  const n = real.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let offset = 0; offset < n; offset += size) {
      let ur = 1, ui = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = offset + k, b = a + size / 2;
        const tr = ur * real[b] - ui * imaginary[b], ti = ur * imaginary[b] + ui * real[b];
        real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
        real[a] += tr; imaginary[a] += ti;
        const nextR = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = nextR;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imaginary[i] /= n; }
}

function denoiseChannel(samples, sampleRate, noiseSeconds, strength) {
  const size = 1024, hop = 256, paddedLength = samples.length + size;
  const padded = new Float32Array(paddedLength);
  padded.set(samples, size / 2);
  const output = new Float32Array(paddedLength), weight = new Float32Array(paddedLength);
  const window = Float32Array.from({ length: size }, (_, i) => Math.sin(Math.PI * (i + 0.5) / size));
  const bins = size / 2 + 1, noise = new Float64Array(bins);
  const noiseFrames = Math.max(1, Math.floor(noiseSeconds * sampleRate / hop));
  let frameCount = 0;
  for (let pos = 0; pos <= paddedLength - size; pos += hop) {
    const real = new Float64Array(size), imaginary = new Float64Array(size);
    for (let i = 0; i < size; i++) real[i] = padded[pos + i] * window[i];
    fft(real, imaginary);
    if (frameCount < noiseFrames) for (let k = 0; k < bins; k++) noise[k] += Math.hypot(real[k], imaginary[k]);
    frameCount++;
  }
  const measured = Math.min(frameCount, noiseFrames);
  for (let k = 0; k < bins; k++) noise[k] /= measured;
  for (let pos = 0; pos <= paddedLength - size; pos += hop) {
    const real = new Float64Array(size), imaginary = new Float64Array(size);
    for (let i = 0; i < size; i++) real[i] = padded[pos + i] * window[i];
    fft(real, imaginary);
    for (let k = 0; k < bins; k++) {
      const magnitude = Math.hypot(real[k], imaginary[k]);
      const gain = magnitude ? Math.max(0.05, 1 - (strength * 1.35 * noise[k]) / magnitude) : 0.05;
      real[k] *= gain; imaginary[k] *= gain;
      if (k > 0 && k < size / 2) { real[size - k] *= gain; imaginary[size - k] *= gain; }
    }
    fft(real, imaginary, true);
    for (let i = 0; i < size; i++) { const index = pos + i; output[index] += real[i] * window[i]; weight[index] += window[i] * window[i]; }
  }
  return Float32Array.from({ length: samples.length }, (_, i) => {
    const index = i + size / 2;
    return weight[index] > 1e-6 ? output[index] / weight[index] : 0;
  });
}

export function reduceNoise(audio, options = {}) {
  const duration = assertAudio(audio);
  const noiseSeconds = Number(options.noiseSeconds ?? Math.min(0.5, duration / 4)), strength = Number(options.strength ?? 0.75);
  if (!Number.isFinite(noiseSeconds) || noiseSeconds < 0.05 || noiseSeconds >= duration) throw new Error("Noise sample must be at least 0.05 seconds and shorter than the audio.");
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("Noise reduction strength must be 0 to 1.");
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((channel) => denoiseChannel(channel, audio.sampleRate, noiseSeconds, strength)) };
}

function resample(samples, factor) {
  const count = Math.max(1, Math.round(samples.length / factor)), output = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const source = Math.min(samples.length - 1, i * factor), left = Math.floor(source), right = Math.min(samples.length - 1, left + 1);
    output[i] = samples[left] + (samples[right] - samples[left]) * (source - left);
  }
  return output;
}

function stretch(samples, ratio, targetLength) {
  if (Math.abs(ratio - 1) < 1e-6) return samples.slice();
  const size = 1024, synthHop = 256, output = new Float32Array(targetLength + size), weights = new Float32Array(targetLength + size);
  const window = Float32Array.from({ length: size }, (_, i) => Math.sin(Math.PI * (i + .5) / size) ** 2);
  const analysisHop = synthHop / ratio;
  for (let frame = 0, outPos = 0; outPos < targetLength; frame++, outPos += synthHop) {
    const inPos = Math.round(frame * analysisHop);
    for (let i = 0; i < size && outPos + i < output.length; i++) {
      const source = inPos + i;
      if (source >= samples.length) break;
      output[outPos + i] += samples[source] * window[i]; weights[outPos + i] += window[i];
    }
  }
  return Float32Array.from({ length: targetLength }, (_, i) => weights[i] > .001 ? output[i] / weights[i] : 0);
}

export function changePitchAndSpeed(audio, options = {}) {
  assertAudio(audio);
  const speed = Number(options.speed ?? 1), semitones = Number(options.semitones ?? 0);
  if (!Number.isFinite(speed) || speed < .5 || speed > 2) throw new Error("Speed must be between 0.5× and 2×.");
  if (!Number.isFinite(semitones) || semitones < -12 || semitones > 12) throw new Error("Pitch must be between -12 and +12 semitones.");
  const pitchFactor = 2 ** (semitones / 12), targetLength = Math.round(audio.channels[0].length / speed);
  if (targetLength / audio.sampleRate > MAX_AUDIO_SECONDS) throw new Error("Result must be three minutes or shorter.");
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((channel) => stretch(resample(channel, pitchFactor), pitchFactor / speed, targetLength)) };
}

export function encodeWav(audio) {
  assertAudio(audio);
  const channelCount = audio.channels.length, frames = audio.channels[0].length;
  const bytes = new Uint8Array(44 + frames * channelCount * 2), view = new DataView(bytes.buffer);
  const writeText = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  writeText(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); writeText(8, "WAVE"); writeText(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channelCount, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true); view.setUint16(34, 16, true);
  writeText(36, "data"); view.setUint32(40, frames * channelCount * 2, true);
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < channelCount; ch++) {
    const sample = Math.max(-1, Math.min(1, audio.channels[ch][i]));
    view.setInt16(44 + (i * channelCount + ch) * 2, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
  }
  return bytes;
}

/** Mixes down and band-limited resamples to Whisper's required 16 kHz mono PCM. */
export function assertSpeechAudio(audio) {
  if (!audio || !Array.isArray(audio.channels) || !audio.channels.length || audio.channels.length > 2 ||
      audio.channels.some((channel) => !(channel instanceof Float32Array)) ||
      audio.channels.reduce((sum, channel) => sum + channel.length, 0) > MAX_TRANSCRIPTION_INPUT_SAMPLES) {
    throw new Error("This recording exceeds the local transcription memory limit.");
  }
  const duration = assertAudio(audio);
  if (duration > MAX_TRANSCRIPTION_SECONDS) throw new Error("Speech transcription accepts audio up to two minutes.");
  return duration;
}

/** Reads duration from a strict RIFF/WAVE header without decoding the recording. */
export function inspectSpeechWavHeader(bytes, fileSize) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  const fourCC = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (fourCC(0) !== "RIFF") return null;
  const invalid = () => { throw new Error("Invalid WAV header."); };
  if (bytes.length < 12 || fourCC(8) !== "WAVE" || !Number.isSafeInteger(fileSize) || fileSize < 44) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== fileSize) invalid();
  let byteRate = 0, blockAlign = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size & 1);
    if (end > fileSize || end <= offset) invalid();
    const id = fourCC(offset);
    if (id === "fmt ") {
      if (size < 16 || offset + 24 > bytes.length) invalid();
      const format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const rate = view.getUint32(offset + 12, true);
      byteRate = view.getUint32(offset + 16, true);
      blockAlign = view.getUint16(offset + 20, true);
      const bits = view.getUint16(offset + 22, true);
      if (![1, 3].includes(format) || channels < 1 || channels > 2 || rate < 8000 || rate > 192000 ||
          ![8, 16, 24, 32, 64].includes(bits) || bits % 8 !== 0 ||
          blockAlign !== channels * bits / 8 || byteRate !== rate * blockAlign) invalid();
    } else if (id === "data") {
      if (!byteRate || !blockAlign || !size || size % blockAlign !== 0) invalid();
      return size / byteRate;
    }
    if (end > bytes.length) break;
    offset = end;
  }
  return null;
}

export function prepareSpeechAudio(audio) {
  const duration = assertSpeechAudio(audio);
  const targetRate = 16000, count = Math.round(duration * targetRate), output = new Float32Array(count);
  const sourceRate = audio.sampleRate, ratio = sourceRate / targetRate, radius = 32;
  const cutoff = .5 * Math.min(1, targetRate / sourceRate);
  for (let i = 0; i < count; i++) {
    const center = i * ratio, first = Math.max(0, Math.ceil(center - radius)), last = Math.min(audio.channels[0].length - 1, Math.floor(center + radius));
    let weighted = 0, weightSum = 0;
    for (let source = first; source <= last; source++) {
      const distance = source - center, normalized = distance / radius;
      const window = .42 + .5 * Math.cos(Math.PI * normalized) + .08 * Math.cos(2 * Math.PI * normalized);
      const x = 2 * cutoff * distance;
      const weight = 2 * cutoff * (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * window;
      let sample = 0;
      for (const channel of audio.channels) sample += channel[source];
      weighted += (sample / audio.channels.length) * weight; weightSum += weight;
    }
    output[i] = weightSum ? weighted / weightSum : 0;
  }
  return output;
}

export function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid timestamp.");
  const minutes = Math.floor(seconds / 60), rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

function srtTime(seconds) {
  const totalMs = Math.round(seconds * 1000), hours = Math.floor(totalMs / 3600000), minutes = Math.floor(totalMs % 3600000 / 60000), sec = Math.floor(totalMs % 60000 / 1000), ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function notesToSrt(notes, duration) {
  if (!Array.isArray(notes) || !Number.isFinite(duration) || duration <= 0) throw new Error("Invalid audio duration or notes.");
  const sorted = notes.filter((note) => note.text?.trim()).sort((a, b) => a.seconds - b.seconds);
  for (const note of sorted) if (!Number.isFinite(note.seconds) || note.seconds < 0 || note.seconds >= duration) throw new Error("A note is outside the audio duration.");
  return sorted.map((note, index) => `${index + 1}\n${srtTime(note.seconds)} --> ${srtTime(sorted[index + 1]?.seconds ?? duration)}\n${note.text.trim()}\n`).join("\n");
}

export function speechExportContent(transcript, chunks, duration, type) {
  if (type === "srt") return notesToSrt(chunks, duration);
  if (type !== "txt" || typeof transcript !== "string" || !transcript.trim()) throw new Error("There is no transcript to export.");
  return transcript.trim();
}
