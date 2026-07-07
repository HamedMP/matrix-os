import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { resolveWritableFileApiPath } from "../path-security.js";
import { shellError } from "./errors.js";

export const TERMINAL_PASTE_ASSET_BODY_LIMIT = 10 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const SAFE_CLIENT_FILENAME = /^[^/\\\0]{1,255}$/;

interface PasteAssetKind {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  extension: ".png" | ".jpg" | ".gif" | ".webp";
}

export interface TerminalPasteAssetInput {
  homePath: string;
  cwd: string;
  bytes: Uint8Array;
  contentType?: string;
  filename?: string;
  now?: Date;
}

export interface TerminalPasteAssetResult {
  path: string;
  terminalPath: string;
  size: number;
  mimeType: string;
}

export async function saveTerminalPasteAsset(input: TerminalPasteAssetInput): Promise<TerminalPasteAssetResult> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > TERMINAL_PASTE_ASSET_BODY_LIMIT) {
    throw shellError("payload_too_large", "Request too large", 413);
  }
  validateClientFilename(input.filename);
  const declaredMime = normalizeContentType(input.contentType);
  if (declaredMime && !SUPPORTED_MIME_TYPES.has(declaredMime)) {
    throw shellError("unsupported_media_type", "Invalid request", 400);
  }
  const kind = detectPasteAssetKind(input.bytes);
  if (!kind || (declaredMime && declaredMime !== kind.mimeType)) {
    throw shellError("unsupported_media_type", "Invalid request", 400);
  }

  const date = formatPasteAssetDate(input.now ?? new Date());
  const relativeDir = join(input.cwd, ".matrix-terminal-pastes", date);
  const filename = `${Date.now()}-${randomUUID()}${kind.extension}`;
  const relativePath = join(relativeDir, filename);
  const absolutePath = resolveWritableFileApiPath(input.homePath, relativePath);
  if (!absolutePath) {
    throw shellError("invalid_request", "Invalid request", 400);
  }
  const absoluteDir = resolveWritableFileApiPath(input.homePath, relativeDir);
  if (!absoluteDir) {
    throw shellError("invalid_request", "Invalid request", 400);
  }

  await mkdir(absoluteDir, { recursive: true });
  const tempPath = join(absoluteDir, `.${filename}.tmp`);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(input.bytes);
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, absolutePath);
  } catch (err: unknown) {
    await unlink(tempPath).catch((cleanupErr: unknown) => {
      console.warn(
        "[shell] failed to clean up terminal paste temp file:",
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      );
    });
    throw err;
  }

  return {
    path: relative(input.homePath, absolutePath).split(sep).join("/"),
    terminalPath: absolutePath,
    size: input.bytes.byteLength,
    mimeType: kind.mimeType,
  };
}

function normalizeContentType(contentType: string | undefined): string | undefined {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function validateClientFilename(filename: string | undefined): void {
  if (filename === undefined || filename === "") {
    return;
  }
  if (!SAFE_CLIENT_FILENAME.test(filename) || filename === "." || filename === "..") {
    throw shellError("invalid_request", "Invalid request", 400);
  }
}

function detectPasteAssetKind(bytes: Uint8Array): PasteAssetKind | null {
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
    return { mimeType: "image/png", extension: ".png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") {
      return { mimeType: "image/gif", extension: ".gif" };
    }
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") {
      return { mimeType: "image/webp", extension: ".webp" };
    }
  }
  return null;
}

function formatPasteAssetDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
