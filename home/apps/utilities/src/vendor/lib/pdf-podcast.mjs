import { encodeWav } from "./audio-tools.mjs";

export const PDF_NARRATION_MAX_BYTES = 12 * 1024 * 1024;
export const PDF_NARRATION_MAX_CHARS = 6000;
export const PDF_NARRATION_MAX_PAGES = 20;
export const PDF_NARRATION_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const PDF_NARRATION_VOICES = Object.freeze([
  { id: "af_heart", label: "Heart · American English" },
  { id: "af_bella", label: "Bella · American English" },
  { id: "am_michael", label: "Michael · American English" },
  { id: "bf_emma", label: "Emma · British English" },
]);

function splitLongPassage(passage, limit) {
  const words = passage.split(/\s+/).filter(Boolean);
  const chunks = [];
  let part = "";
  for (const word of words) {
    if (word.length > limit) throw new Error("The PDF contains a word too long to narrate. Edit the extracted text and try again.");
    if (part && `${part} ${word}`.length > limit) { chunks.push(part); part = word; }
    else part = part ? `${part} ${word}` : word;
  }
  if (part) chunks.push(part);
  return chunks;
}

export function buildPdfNarration(pages, { maxChars = PDF_NARRATION_MAX_CHARS, maxChunkChars = 380 } = {}) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > PDF_NARRATION_MAX_PAGES) {
    throw new Error(`Choose a PDF with 1–${PDF_NARRATION_MAX_PAGES} pages.`);
  }
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < 80 || maxChunkChars > 500) throw new Error("Invalid narration chunk length.");
  const text = pages.map((rows) => {
    if (!Array.isArray(rows)) throw new Error("Could not read PDF text.");
    return rows.map((row) => String(row).replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  }).filter(Boolean).join("\n\n").replace(/([a-zA-Z])-\s+([a-zA-Z])/g, "$1$2").trim();
  if (!text) throw new Error("This PDF has no selectable text. For scanned pages, run OCR first.");
  if (text.length > maxChars) throw new Error(`Narration is limited to ${maxChars.toLocaleString("en-US")} characters. Edit the extracted text or choose a shorter PDF.`);
  const chunks = [];
  for (const paragraph of text.split(/\n+/)) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+(?:["”']+)?|[^.!?]+$/g) ?? [paragraph];
    let part = "";
    for (const sentence of sentences.map((value) => value.trim()).filter(Boolean)) {
      if (sentence.length > maxChunkChars) {
        if (part) { chunks.push(part); part = ""; }
        chunks.push(...splitLongPassage(sentence, maxChunkChars));
      } else if (part && `${part} ${sentence}`.length > maxChunkChars) { chunks.push(part); part = sentence; }
      else part = part ? `${part} ${sentence}` : sentence;
    }
    if (part) chunks.push(part);
  }
  return { text, chunks, pageCount: pages.length, characterCount: text.length };
}

export function joinNarrationAudio(parts, { silenceSeconds = 0.12 } = {}) {
  const sampleRate = 24000;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 60 || !Number.isFinite(silenceSeconds) || silenceSeconds < 0 || silenceSeconds > 1) throw new Error("Invalid audio segments.");
  const gap = Math.round(silenceSeconds * sampleRate);
  let frames = gap * (parts.length - 1);
  for (const part of parts) {
    if (!(part?.audio instanceof Float32Array) || part.sampling_rate !== sampleRate || !part.audio.length || part.audio.some((value) => !Number.isFinite(value))) throw new Error("The local voice model produced invalid audio.");
    frames += part.audio.length;
    if (frames > sampleRate * 600) throw new Error("Generated audio exceeds the ten-minute limit.");
  }
  const samples = new Float32Array(frames);
  let offset = 0;
  parts.forEach((part, index) => {
    samples.set(part.audio, offset);
    offset += part.audio.length + (index < parts.length - 1 ? gap : 0);
  });
  return { samples, sampleRate, durationSeconds: samples.length / sampleRate };
}

export function wavFromNarration({ samples, sampleRate }) {
  if (!(samples instanceof Float32Array) || sampleRate !== 24000 || !samples.length || samples.length > sampleRate * 600) throw new Error("Invalid narration audio.");
  return encodeWav({ channels: [samples], sampleRate });
}
