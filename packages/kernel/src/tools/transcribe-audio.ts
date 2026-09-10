import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 65_000;

export interface OwnerAudioTranscriber {
  transcribe(input: {
    audio: Uint8Array;
    fileName: string;
    signal: AbortSignal;
  }): Promise<{ text: string; durationMs: number }>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function unavailable(): ToolResult {
  return { content: [{ type: "text", text: "Transcription unavailable" }] };
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative !== "" && !childRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && childRelative !== ".." && !isAbsolute(childRelative);
}

async function readOwnerAudio(homePath: string, requestedPath: string, maxBytes: number) {
  if (requestedPath.length < 1 || requestedPath.length > 4_096 || requestedPath.includes("\0")) return undefined;
  const withoutHomeAlias = requestedPath.startsWith("~/") ? requestedPath.slice(2) : requestedPath;
  const target = isAbsolute(withoutHomeAlias) ? resolve(withoutHomeAlias) : resolve(homePath, withoutHomeAlias);
  const resolvedHome = await realpath(homePath);
  const resolvedParent = await realpath(dirname(target));
  if (!isWithin(resolvedHome, resolvedParent) && resolvedParent !== resolvedHome) return undefined;
  const pathStat = await lstat(target);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) return undefined;
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) return undefined;
    return { audio: new Uint8Array(await file.readFile()), fileName: basename(target) };
  } finally {
    await file.close();
  }
}

export function createTranscribeAudioToolHandler(options: {
  homePath?: string;
  transcriber?: OwnerAudioTranscriber;
  maxBytes?: number;
  timeoutMs?: number;
}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_AUDIO_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 90_000) {
    throw new Error("Owner audio transcription limits are invalid");
  }
  return async ({ audio_path }: { audio_path: string }): Promise<ToolResult> => {
    if (!options.homePath || !options.transcriber) return unavailable();
    try {
      const source = await readOwnerAudio(options.homePath, audio_path, maxBytes);
      if (!source) return unavailable();
      const result = await options.transcriber.transcribe({
        ...source,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = result.text.trim();
      return {
        content: [{
          type: "text",
          text: text.length > 0 ? `Transcription: ${text}` : "Transcription completed with no speech",
        }],
      };
    } catch (_error: unknown) {
      return unavailable();
    }
  };
}
