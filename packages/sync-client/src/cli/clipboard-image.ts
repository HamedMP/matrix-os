import { execFile } from "node:child_process";
import type { ClipboardImageCandidate } from "./rich-paste.js";
import {
  RICH_PASTE_MAX_IMAGE_BYTES,
  type RichPasteImageMimeType,
} from "./rich-paste.js";

export const CLIPBOARD_IMAGE_TIMEOUT_MS = 2_000;

export type ClipboardImageUnavailableReason =
  | "unsupported_platform"
  | "missing_helper"
  | "empty_clipboard"
  | "timeout"
  | "read_failed";

export type ClipboardImageReaderResult =
  | {
      status: "available";
      candidate: ClipboardImageCandidate;
    }
  | {
      status: "unavailable";
      reason: ClipboardImageUnavailableReason;
    };

export interface ClipboardImageReader {
  readImage(): Promise<ClipboardImageReaderResult>;
}

export interface ClipboardImageCommandRunner {
  execFile(input: {
    file: string;
    args: string[];
    timeoutMs: number;
  }): Promise<{
    stdout: Uint8Array;
    stderr: Uint8Array;
  }>;
}

export interface MacOsClipboardImageReaderOptions {
  platform?: NodeJS.Platform;
  commandRunner?: ClipboardImageCommandRunner;
  timeoutMs?: number;
  now?: () => Date;
}

export function createUnsupportedClipboardImageReader(
  reason: ClipboardImageUnavailableReason = "unsupported_platform",
): ClipboardImageReader {
  return {
    async readImage() {
      return { status: "unavailable", reason };
    },
  };
}

export function createMacOsClipboardImageReader(
  options: MacOsClipboardImageReaderOptions = {},
): ClipboardImageReader {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? CLIPBOARD_IMAGE_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const commandRunner = options.commandRunner ?? createNodeClipboardImageCommandRunner();

  return {
    async readImage() {
      if (platform !== "darwin") {
        return { status: "unavailable", reason: "unsupported_platform" };
      }

      let output: Uint8Array;
      try {
        const result = await commandRunner.execFile({
          file: "pngpaste",
          args: ["-"],
          timeoutMs,
        });
        output = result.stdout;
      } catch (err: unknown) {
        return { status: "unavailable", reason: reasonForCommandFailure(err) };
      }

      if (output.byteLength < 1) {
        return { status: "unavailable", reason: "empty_clipboard" };
      }
      if (output.byteLength > RICH_PASTE_MAX_IMAGE_BYTES) {
        return { status: "unavailable", reason: "read_failed" };
      }

      const mimeType = sniffImageMimeType(output);
      if (!mimeType) {
        return { status: "unavailable", reason: "empty_clipboard" };
      }

      const bytes = new Uint8Array(output);
      return {
        status: "available",
        candidate: {
          kind: "clipboard",
          capturedAt: now(),
          sizeBytes: bytes.byteLength,
          mimeType,
          bytes,
        } satisfies ClipboardImageCandidate,
      };
    },
  };
}

function createNodeClipboardImageCommandRunner(): ClipboardImageCommandRunner {
  return {
    execFile(input) {
      return new Promise((resolve, reject) => {
        execFile(
          input.file,
          input.args,
          {
            encoding: "buffer",
            maxBuffer: RICH_PASTE_MAX_IMAGE_BYTES + 1,
            timeout: input.timeoutMs,
          },
          (err, stdout, stderr) => {
            if (err) {
              reject(err);
              return;
            }
            resolve({
              stdout: new Uint8Array(stdout),
              stderr: new Uint8Array(stderr),
            });
          },
        );
      });
    },
  };
}

function reasonForCommandFailure(err: unknown): ClipboardImageUnavailableReason {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "missing_helper";
    }
    if (code === "ETIMEDOUT" || err.name === "TimeoutError") {
      return "timeout";
    }
  }
  return "read_failed";
}

function sniffImageMimeType(bytes: Uint8Array): RichPasteImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
