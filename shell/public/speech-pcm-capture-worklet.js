/**
 * Bounded batch-dictation PCM16 capture. The main thread owns all limits and
 * packages these transferred samples as a WAV only after the user presses Stop.
 */
class SpeechPcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.chunkSamples = 16_384;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush") return;
      this.emit(true);
      this.port.postMessage({ type: "flushed" });
    };
  }

  emit(force = false) {
    if (!force && this.samples.length < this.chunkSamples) return;
    if (this.samples.length === 0) return;
    const length = force ? this.samples.length : this.chunkSamples;
    const output = new Int16Array(length);
    for (let index = 0; index < length; index += 1) output[index] = this.samples[index];
    this.samples.splice(0, length);
    this.port.postMessage({ type: "audio", bytes: output.buffer }, [output.buffer]);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.samples.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    }
    this.emit();
    return true;
  }
}

registerProcessor("speech-pcm16-capture", SpeechPcm16CaptureProcessor);
