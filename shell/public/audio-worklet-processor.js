/**
 * PCM16 Audio Worklet Processor
 * Captures mic audio and emits PCM16 byte arrays.
 * Base64 encoding happens in the main thread (btoa unavailable in AudioWorkletGlobalScope).
 */
class PCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // Send chunks every ~100ms (1600 samples at 16kHz)
    this._chunkSize = 1600;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      this._buffer.push(s < 0 ? s * 0x8000 : s * 0x7FFF);
    }

    if (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.splice(0, this._chunkSize);
      const pcm16 = new Int16Array(chunk);
      // Transfer raw bytes — main thread handles base64
      this.port.postMessage({ type: "audio", bytes: pcm16.buffer }, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm16-processor", PCM16Processor);
