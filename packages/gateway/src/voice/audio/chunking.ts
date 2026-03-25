export function chunkAudio(
  audio: Buffer,
  frameSizeMs = 20,
  sampleRate = 8000,
  bytesPerSample = 1,
): Buffer[] {
  const samplesPerFrame = Math.floor((sampleRate * frameSizeMs) / 1000);
  const bytesPerFrame = samplesPerFrame * bytesPerSample;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < audio.length; offset += bytesPerFrame) {
    chunks.push(
      audio.subarray(offset, Math.min(offset + bytesPerFrame, audio.length)),
    );
  }
  return chunks;
}

export function reassemble(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks);
}
