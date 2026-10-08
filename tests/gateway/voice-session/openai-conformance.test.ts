/**
 * Credential-gated live conformance for the direct OpenAI speech ports.
 *
 * Runs ONLY under `bun run test:voice:conformance` with
 * `MATRIX_VOICE_CONFORMANCE_OPENAI=1` and `MATRIX_VOICE_OPENAI_API_KEY` set —
 * it makes real provider calls. Without the flag every suite is skipped and
 * the run exits green; enabling the flag without a key fails loudly so a
 * misconfigured conformance run can never go silently green.
 */
import { describe, expect, it } from "vitest";
import { createDirectOpenAiSpeechPorts } from "../../../packages/gateway/src/voice-session/direct-openai-ports.js";

const CONFORMANCE_ENABLED = process.env.MATRIX_VOICE_CONFORMANCE_OPENAI === "1";
const API_KEY = process.env.MATRIX_VOICE_OPENAI_API_KEY?.trim();

if (!CONFORMANCE_ENABLED) {
  console.log(
    "skipped: set MATRIX_VOICE_CONFORMANCE_OPENAI=1 and MATRIX_VOICE_OPENAI_API_KEY to run live OpenAI voice conformance",
  );
}

it("requires MATRIX_VOICE_OPENAI_API_KEY whenever conformance is enabled", () => {
  if (CONFORMANCE_ENABLED) {
    expect(API_KEY, "MATRIX_VOICE_CONFORMANCE_OPENAI=1 without MATRIX_VOICE_OPENAI_API_KEY").toBeTruthy();
  }
});

describe.skipIf(!CONFORMANCE_ENABLED)("OpenAI live voice conformance (real provider calls)", () => {
  it("declares 24kHz mono s16le output, streams PCM, and transcribes canonical WAV", async () => {
    const ports = createDirectOpenAiSpeechPorts({
      apiKey: API_KEY!,
      transcriptionModel: process.env.MATRIX_VOICE_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
      speechModel: process.env.MATRIX_VOICE_SPEECH_MODEL ?? "gpt-4o-mini-tts",
      voice: process.env.MATRIX_VOICE_SPEECH_VOICE ?? "alloy",
    });
    expect(ports.outputAudio).toEqual({ codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 });

    const chunks: Buffer[] = [];
    for await (const chunk of ports.synthesize({
      text: "Voice conformance check.",
      signal: AbortSignal.timeout(60_000),
    })) {
      chunks.push(chunk);
    }
    const pcm = Buffer.concat(chunks);
    expect(pcm.length).toBeGreaterThan(0);
    expect(pcm.length % 2).toBe(0); // s16le whole samples

    // Round-trip: re-wrap the synthesized 24kHz PCM as WAV and transcribe it.
    const wav = encodeWavS16(pcm, 24_000, 1);
    const result = await ports.transcribe({ wav, signal: AbortSignal.timeout(55_000) });
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  }, 120_000);
});

function encodeWavS16(pcm: Buffer, sampleRateHz: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
