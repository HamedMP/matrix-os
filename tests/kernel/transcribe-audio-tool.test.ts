import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTranscribeAudioToolHandler,
  type OwnerAudioTranscriber,
} from "../../packages/kernel/src/tools/transcribe-audio.js";

describe("managed owner-audio transcription tool", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fixture() {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-owner-audio-"));
    homes.push(homePath);
    const audioDir = join(homePath, "data", "audio");
    await mkdir(audioDir, { recursive: true });
    const audioPath = join(audioDir, "voice-note.ogg");
    const audio = Buffer.from("OggS-owner-source-audio");
    await writeFile(audioPath, audio);
    return { homePath, audioPath, audio };
  }

  it("reads a bounded owner file, preserves it, and delegates to the injected managed service", async () => {
    const { homePath, audioPath, audio } = await fixture();
    const transcriber: OwnerAudioTranscriber = {
      transcribe: vi.fn(async () => ({ text: "hello from owner audio", durationMs: 1_000 })),
    };
    const handler = createTranscribeAudioToolHandler({ homePath, transcriber });

    await expect(handler({ audio_path: "~/data/audio/voice-note.ogg" })).resolves.toEqual({
      content: [{ type: "text", text: "Transcription: hello from owner audio" }],
    });
    expect(transcriber.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      audio: new Uint8Array(audio),
      fileName: "voice-note.ogg",
      signal: expect.any(AbortSignal),
    }));
    await expect(readFile(audioPath)).resolves.toEqual(audio);
  });

  it("rejects symlink escape and oversized input before delegation", async () => {
    const { homePath } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "matrix-outside-audio-"));
    homes.push(outside);
    const outsidePath = join(outside, "private.wav");
    await writeFile(outsidePath, Buffer.alloc(64, 1));
    await symlink(outsidePath, join(homePath, "data", "audio", "escape.wav"));
    await writeFile(join(homePath, "data", "audio", "huge.wav"), Buffer.alloc(129, 1));
    const transcriber: OwnerAudioTranscriber = { transcribe: vi.fn() };
    const handler = createTranscribeAudioToolHandler({ homePath, transcriber, maxBytes: 128 });

    await expect(handler({ audio_path: "data/audio/escape.wav" })).resolves.toMatchObject({
      content: [{ text: "Transcription unavailable" }],
    });
    await expect(handler({ audio_path: "data/audio/huge.wav" })).resolves.toMatchObject({
      content: [{ text: "Transcription unavailable" }],
    });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("does not expose managed provider, wallet, or filesystem failures", async () => {
    const { homePath } = await fixture();
    const transcriber: OwnerAudioTranscriber = {
      transcribe: vi.fn(async () => { throw new Error("OpenAI balance failed at /secret/path"); }),
    };
    const handler = createTranscribeAudioToolHandler({ homePath, transcriber });
    const result = await handler({ audio_path: "data/audio/voice-note.ogg" });
    expect(result).toEqual({ content: [{ type: "text", text: "Transcription unavailable" }] });
    expect(JSON.stringify(result)).not.toMatch(/openai|balance|secret|path/i);
  });
});
