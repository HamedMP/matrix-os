import { describe, expect, it, vi } from "vitest";
import {
  createMacOsClipboardImageReader,
  CLIPBOARD_IMAGE_TIMEOUT_MS,
  type ClipboardImageCommandRunner,
} from "../../src/cli/clipboard-image.js";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

describe("cli/clipboard-image", () => {
  it("reads macOS clipboard image bytes with an injectable pngpaste runner", async () => {
    const commandRunner: ClipboardImageCommandRunner = {
      execFile: vi.fn(async () => ({ stdout: pngBytes, stderr: new Uint8Array() })),
    };
    const reader = createMacOsClipboardImageReader({
      platform: "darwin",
      commandRunner,
      now: () => new Date("2026-07-08T12:00:00.000Z"),
    });

    const result = await reader.readImage();

    expect(result).toEqual({
      status: "available",
      candidate: {
        kind: "clipboard",
        capturedAt: new Date("2026-07-08T12:00:00.000Z"),
        sizeBytes: pngBytes.byteLength,
        mimeType: "image/png",
        bytes: new Uint8Array(pngBytes),
      },
    });
    expect(commandRunner.execFile).toHaveBeenCalledWith({
      file: "pngpaste",
      args: ["-"],
      timeoutMs: CLIPBOARD_IMAGE_TIMEOUT_MS,
    });
  });

  it("reports unsupported platforms without executing helpers", async () => {
    const commandRunner: ClipboardImageCommandRunner = {
      execFile: vi.fn(),
    };
    const reader = createMacOsClipboardImageReader({
      platform: "linux",
      commandRunner,
    });

    await expect(reader.readImage()).resolves.toEqual({
      status: "unavailable",
      reason: "unsupported_platform",
    });
    expect(commandRunner.execFile).not.toHaveBeenCalled();
  });

  it("maps a missing pngpaste helper to a safe unavailable result", async () => {
    const commandRunner: ClipboardImageCommandRunner = {
      execFile: vi.fn(async () => {
        throw Object.assign(new Error("spawn pngpaste ENOENT"), { code: "ENOENT" });
      }),
    };
    const reader = createMacOsClipboardImageReader({
      platform: "darwin",
      commandRunner,
    });

    await expect(reader.readImage()).resolves.toEqual({
      status: "unavailable",
      reason: "missing_helper",
    });
  });

  it("reports an empty clipboard without claiming success", async () => {
    const commandRunner: ClipboardImageCommandRunner = {
      execFile: vi.fn(async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array() })),
    };
    const reader = createMacOsClipboardImageReader({
      platform: "darwin",
      commandRunner,
    });

    await expect(reader.readImage()).resolves.toEqual({
      status: "unavailable",
      reason: "empty_clipboard",
    });
  });

  it("maps helper timeout to a safe timeout result", async () => {
    const commandRunner: ClipboardImageCommandRunner = {
      execFile: vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      }),
    };
    const reader = createMacOsClipboardImageReader({
      platform: "darwin",
      commandRunner,
    });

    await expect(reader.readImage()).resolves.toEqual({
      status: "unavailable",
      reason: "timeout",
    });
  });
});
