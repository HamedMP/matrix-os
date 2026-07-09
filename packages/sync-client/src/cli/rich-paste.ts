import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { ClipboardImageReader } from "./clipboard-image.js";

export const RICH_PASTE_MAX_ASSETS = 5;
export const RICH_PASTE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const RICH_PASTE_UPLOAD_TIMEOUT_MS = 30_000;

export const RICH_PASTE_LOCAL_FAILURE_MESSAGES = {
  local_read_failed: "Image paste failed: local image could not be read.",
  image_too_large: "Image paste failed: image is too large.",
  upload_failed: "Image paste failed: upload did not complete.",
  unsupported_paste_event: "Image paste is not supported by this terminal paste event.",
} as const;

export const RICH_PASTE_IMAGE_TYPES = {
  png: {
    mimeType: "image/png",
    extensions: [".png"],
  },
  jpeg: {
    mimeType: "image/jpeg",
    extensions: [".jpg", ".jpeg"],
  },
  gif: {
    mimeType: "image/gif",
    extensions: [".gif"],
  },
  webp: {
    mimeType: "image/webp",
    extensions: [".webp"],
  },
} as const;

export type RichPasteImageMimeType =
  (typeof RICH_PASTE_IMAGE_TYPES)[keyof typeof RICH_PASTE_IMAGE_TYPES]["mimeType"];

export type PasteTransactionState =
  | "collecting"
  | "validating"
  | "uploading"
  | "rewriting"
  | "forwarded"
  | "failed";

export type RichPasteFailureCode = keyof typeof RICH_PASTE_LOCAL_FAILURE_MESSAGES;

export interface PasteTextRange {
  start: number;
  end: number;
}

export interface PasteTransaction {
  transactionId: string;
  sessionName: string;
  rawText: string;
  detectedCandidates: LocalImageCandidate[];
  clipboardCandidate?: ClipboardImageCandidate;
  assetCount: number;
  state: PasteTransactionState;
  failureCode?: RichPasteFailureCode;
}

export interface LocalImageCandidate {
  kind: "local-path";
  sourceTextRange: PasteTextRange;
  displayText: string;
  localPath: string;
  dedupeKey: string;
  sizeBytes: number;
  mimeType: RichPasteImageMimeType;
  bytes?: Uint8Array;
}

export interface ClipboardImageCandidate {
  kind: "clipboard";
  capturedAt: Date;
  sizeBytes: number;
  mimeType: RichPasteImageMimeType;
  bytes: Uint8Array;
}

export interface RemotePasteAsset {
  assetId: string;
  path: string;
  homeRelativePath: string;
  mimeType: RichPasteImageMimeType;
  size: number;
}

export type RewriteResult =
  | {
      status: "passthrough";
      outgoingText: string;
      assets: [];
      localMessage?: undefined;
    }
  | {
      status: "rewritten";
      outgoingText: string;
      assets: RemotePasteAsset[];
      localMessage?: undefined;
    }
  | {
      status: "failed";
      outgoingText?: undefined;
      assets: [];
      localMessage: string;
      failureCode: RichPasteFailureCode;
    };

export interface RichPasteUploadAsset {
  name: string;
  mimeType: RichPasteImageMimeType;
  bytes: Uint8Array;
}

export interface RichPasteUploadClient {
  uploadPasteAssets(input: {
    sessionName: string;
    transactionId: string;
    assets: RichPasteUploadAsset[];
  }): Promise<RemotePasteAsset[]>;
}

export interface RichPasteRewriteInput {
  sessionName: string;
  text: string;
  observablePaste: boolean;
}

export interface RichPasteRewriter {
  rewrite(input: RichPasteRewriteInput): Promise<RewriteResult>;
}

export interface ProcessRichPasteTransactionInput extends RichPasteRewriteInput {
  uploadClient: RichPasteUploadClient;
  clipboardReader?: ClipboardImageReader;
}

export interface RichPasteUploadClientOptions {
  gatewayUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  cwd?: string;
}

export interface RichPasteInputSegment {
  text: string;
  observablePaste: boolean;
}

type InternalCandidate = LocalImageCandidate & {
  quote?: "\"" | "'";
  uploadIndex?: number;
};

const IMAGE_EXTENSIONS = Object.values(RICH_PASTE_IMAGE_TYPES)
  .flatMap((type) => type.extensions);
const IMAGE_EXTENSION_PATTERN = IMAGE_EXTENSIONS
  .map((extension) => extension.replace(".", "\\."))
  .join("|");
const QUOTED_PATH_PATTERN = new RegExp(`(["'])([^"'\\r\\n]+?(?:${IMAGE_EXTENSION_PATTERN}))\\1`, "gi");
const UNQUOTED_PATH_PATTERN = new RegExp(`(^|[\\s(])((?:~\\/|\\/)[^\\s"'<>]+?(?:${IMAGE_EXTENSION_PATTERN}))`, "gi");

export function shouldProcessRichPasteText(text: string): boolean {
  return /(?:~\/|\/)[^\r\n]*\.(?:png|jpe?g|gif|webp)(?=$|[\s)"'.,:;!?])/i.test(text);
}

export function splitBracketedPasteInput(input: string): RichPasteInputSegment[] | null {
  const startMarker = "\u001b[200~";
  const endMarker = "\u001b[201~";
  if (!input.includes(startMarker)) {
    return null;
  }

  const segments: RichPasteInputSegment[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf(startMarker, cursor);
    if (start === -1) {
      const tail = input.slice(cursor);
      if (tail.length > 0) {
        segments.push({ text: tail, observablePaste: false });
      }
      break;
    }
    if (start > cursor) {
      segments.push({ text: input.slice(cursor, start), observablePaste: false });
    }
    const contentStart = start + startMarker.length;
    const end = input.indexOf(endMarker, contentStart);
    if (end === -1) {
      return null;
    }
    segments.push({ text: input.slice(contentStart, end), observablePaste: true });
    cursor = end + endMarker.length;
  }

  return segments;
}

export function createRichPasteUploadClient(options: RichPasteUploadClientOptions): RichPasteUploadClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RICH_PASTE_UPLOAD_TIMEOUT_MS;
  const base = options.gatewayUrl.replace(/\/+$/, "");

  return {
    async uploadPasteAssets(input) {
      const uploaded: RemotePasteAsset[] = [];
      for (const [index, asset] of input.assets.entries()) {
        const headers: Record<string, string> = {
          "Content-Type": asset.mimeType,
          "X-Matrix-Filename": asset.name,
        };
        if (options.token) {
          headers.Authorization = `Bearer ${options.token}`;
        }
        const body = Buffer.from(asset.bytes);
        const query = options.cwd ? `?${new URLSearchParams({ cwd: options.cwd }).toString()}` : "";

        let res: Response;
        try {
          res = await fetchImpl(
            `${base}/api/terminal/sessions/${encodeURIComponent(input.sessionName)}/paste-assets${query}`,
            {
              method: "POST",
              headers,
              body,
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
        } catch (err: unknown) {
          throw codedError("Image paste failed", "upload_failed", err);
        }

        if (!res.ok) {
          throw codedError("Image paste failed", "upload_failed");
        }

        let payload: unknown;
        try {
          payload = await res.json();
        } catch (err: unknown) {
          throw codedError("Image paste failed", "upload_failed", err);
        }

        uploaded.push(parseUploadResponse(payload, index));
      }
      return uploaded;
    },
  };
}

export function createRichPasteRewriter(input: {
  uploadClient: RichPasteUploadClient;
  clipboardReader?: ClipboardImageReader;
}): RichPasteRewriter {
  return {
    rewrite: (transaction) => processRichPasteTransaction({
      ...transaction,
      uploadClient: input.uploadClient,
      clipboardReader: input.clipboardReader,
    }),
  };
}

export async function processRichPasteTransaction(
  input: ProcessRichPasteTransactionInput,
): Promise<RewriteResult> {
  if (!shouldProcessRichPasteText(input.text) && !(input.observablePaste && input.text.length === 0)) {
    return { status: "passthrough", outgoingText: input.text, assets: [] };
  }

  const validation = await collectLocalImageCandidates(input.text);
  if (validation.status === "failed") {
    if (input.observablePaste && validation.clipboardFallbackCandidate) {
      const fallback = await processClipboardPaste(input, {
        candidateToReplace: validation.clipboardFallbackCandidate,
        unsupportedFailureCode: validation.failureCode,
      });
      // Return fallback success, or a more specific clipboard failure such as image_too_large.
      if (fallback.status !== "failed" || fallback.failureCode !== validation.failureCode) {
        return fallback;
      }
    }
    return failedResult(validation.failureCode);
  }
  const candidates = validation.candidates;
  if (candidates.length === 0) {
    if (input.observablePaste && input.text.length === 0) {
      return processClipboardPaste(input);
    }
    return { status: "passthrough", outgoingText: input.text, assets: [] };
  }

  const deduped = dedupeCandidates(candidates);
  if (deduped.length > RICH_PASTE_MAX_ASSETS) {
    return failedResult("upload_failed");
  }

  let remoteAssets: RemotePasteAsset[];
  try {
    remoteAssets = await input.uploadClient.uploadPasteAssets({
      sessionName: input.sessionName,
      transactionId: randomUUID(),
      assets: deduped.map((candidate) => ({
        name: basename(candidate.localPath),
        mimeType: candidate.mimeType,
        bytes: candidate.bytes ?? new Uint8Array(),
      })),
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      return failedResult("upload_failed");
    }
    return failedResult("upload_failed");
  }

  if (remoteAssets.length !== deduped.length) {
    return failedResult("upload_failed");
  }

  return {
    status: "rewritten",
    outgoingText: rewriteText(input.text, candidates, remoteAssets),
    assets: remoteAssets,
  };
}

async function processClipboardPaste(
  input: ProcessRichPasteTransactionInput,
  options: {
    candidateToReplace?: InternalCandidate;
    unsupportedFailureCode?: RichPasteFailureCode;
  } = {},
): Promise<RewriteResult> {
  const unsupportedFailureCode = options.unsupportedFailureCode ?? "unsupported_paste_event";
  if (!input.clipboardReader) {
    return failedResult(unsupportedFailureCode);
  }
  const clipboard = await input.clipboardReader.readImage();
  if (clipboard.status !== "available") {
    return failedResult(unsupportedFailureCode);
  }
  if (clipboard.candidate.sizeBytes > RICH_PASTE_MAX_IMAGE_BYTES) {
    return failedResult("image_too_large");
  }

  let remoteAssets: RemotePasteAsset[];
  try {
    remoteAssets = await input.uploadClient.uploadPasteAssets({
      sessionName: input.sessionName,
      transactionId: randomUUID(),
      assets: [{
        name: "clipboard.png",
        mimeType: clipboard.candidate.mimeType,
        bytes: clipboard.candidate.bytes,
      }],
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      return failedResult("upload_failed");
    }
    return failedResult("upload_failed");
  }
  if (remoteAssets.length !== 1 || !remoteAssets[0]) {
    return failedResult("upload_failed");
  }
  return {
    status: "rewritten",
    outgoingText: options.candidateToReplace
      ? rewriteText(input.text, [{ ...options.candidateToReplace, uploadIndex: 0 }], remoteAssets)
      : `Please inspect this image: ${remoteAssets[0].path}`,
    assets: remoteAssets,
  };
}

async function collectLocalImageCandidates(text: string): Promise<
  | { status: "ok"; candidates: InternalCandidate[] }
  | {
      status: "failed";
      failureCode: RichPasteFailureCode;
      clipboardFallbackCandidate?: InternalCandidate;
    }
> {
  const rawCandidates = findRawCandidates(text);
  const candidates: InternalCandidate[] = [];
  const clipboardFallbackCandidate = singlePathOnlyCandidate(text, rawCandidates);

  for (const raw of rawCandidates) {
    const result = await validateLocalCandidate(raw);
    if (result.status === "skip") {
      continue;
    }
    if (result.status === "failed") {
      return {
        status: "failed",
        failureCode: result.failureCode,
        clipboardFallbackCandidate: result.failureCode === "local_read_failed"
          ? clipboardFallbackCandidate
          : undefined,
      };
    }
    candidates.push(result.candidate);
  }

  return { status: "ok", candidates };
}

function findRawCandidates(text: string): InternalCandidate[] {
  const candidates: InternalCandidate[] = [];
  const occupiedRanges: PasteTextRange[] = [];

  for (const match of text.matchAll(QUOTED_PATH_PATTERN)) {
    const fullMatch = match[0];
    const quote = match[1] as "\"" | "'";
    const rawPath = match[2];
    if (!rawPath || match.index === undefined) {
      continue;
    }
    const start = match.index;
    const end = start + fullMatch.length;
    occupiedRanges.push({ start, end });
    candidates.push(createRawCandidate({
      text,
      start,
      end,
      displayText: fullMatch,
      rawPath,
      quote,
    }));
  }

  for (const match of text.matchAll(UNQUOTED_PATH_PATTERN)) {
    const prefix = match[1] ?? "";
    const rawPath = match[2];
    if (!rawPath || match.index === undefined) {
      continue;
    }
    const start = match.index + prefix.length;
    const end = start + rawPath.length;
    if (occupiedRanges.some((range) => rangesOverlap({ start, end }, range))) {
      continue;
    }
    candidates.push(createRawCandidate({
      text,
      start,
      end,
      displayText: text.slice(start, end),
      rawPath,
    }));
  }

  return candidates.sort((left, right) => left.sourceTextRange.start - right.sourceTextRange.start);
}

function singlePathOnlyCandidate(text: string, candidates: InternalCandidate[]): InternalCandidate | undefined {
  if (candidates.length !== 1) {
    return undefined;
  }
  const candidate = candidates[0];
  if (!candidate || text.trim() !== candidate.displayText.trim()) {
    return undefined;
  }
  return candidate;
}

function createRawCandidate(input: {
  text: string;
  start: number;
  end: number;
  displayText: string;
  rawPath: string;
  quote?: "\"" | "'";
}): InternalCandidate {
  const localPath = expandLocalPath(input.rawPath);
  return {
    kind: "local-path",
    sourceTextRange: { start: input.start, end: input.end },
    displayText: input.displayText,
    localPath,
    dedupeKey: localPath,
    sizeBytes: 0,
    mimeType: mimeTypeFromExtension(input.rawPath) ?? "image/png",
    quote: input.quote,
  };
}

async function validateLocalCandidate(candidate: InternalCandidate): Promise<
  | { status: "ok"; candidate: InternalCandidate }
  | { status: "skip" }
  | { status: "failed"; failureCode: RichPasteFailureCode }
> {
  const extensionMimeType = mimeTypeFromExtension(candidate.localPath);
  if (!extensionMimeType) {
    return { status: "skip" };
  }

  try {
    const linkStats = await lstat(candidate.localPath);
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
      return { status: "failed", failureCode: "local_read_failed" };
    }
    if (linkStats.size > RICH_PASTE_MAX_IMAGE_BYTES) {
      return { status: "failed", failureCode: "image_too_large" };
    }
    const [stats, bytes, resolvedRealPath] = await Promise.all([
      stat(candidate.localPath),
      readFile(candidate.localPath),
      realpath(candidate.localPath),
    ]);
    if (!stats.isFile()) {
      return { status: "failed", failureCode: "local_read_failed" };
    }
    if (bytes.byteLength > RICH_PASTE_MAX_IMAGE_BYTES) {
      return { status: "failed", failureCode: "image_too_large" };
    }
    const sniffedMimeType = sniffImageMimeType(bytes);
    if (!sniffedMimeType || sniffedMimeType !== extensionMimeType) {
      return { status: "failed", failureCode: "local_read_failed" };
    }
    return {
      status: "ok",
      candidate: {
        ...candidate,
        localPath: resolvedRealPath,
        dedupeKey: resolvedRealPath,
        sizeBytes: bytes.byteLength,
        mimeType: sniffedMimeType,
        bytes,
      },
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      return { status: "failed", failureCode: "local_read_failed" };
    }
    return { status: "failed", failureCode: "local_read_failed" };
  }
}

function dedupeCandidates(candidates: InternalCandidate[]): InternalCandidate[] {
  const uploadCandidates: InternalCandidate[] = [];
  const seen: Array<{ key: string; index: number }> = [];
  for (const candidate of candidates) {
    const existing = seen.find((entry) => entry.key === candidate.dedupeKey);
    if (existing) {
      candidate.uploadIndex = existing.index;
      continue;
    }
    candidate.uploadIndex = uploadCandidates.length;
    seen.push({ key: candidate.dedupeKey, index: candidate.uploadIndex });
    uploadCandidates.push(candidate);
  }
  return uploadCandidates;
}

function rewriteText(
  text: string,
  candidates: InternalCandidate[],
  remoteAssets: RemotePasteAsset[],
): string {
  let output = "";
  let cursor = 0;
  for (const candidate of candidates) {
    const replacement = remoteAssets[candidate.uploadIndex ?? 0]?.path;
    if (!replacement) {
      continue;
    }
    output += text.slice(cursor, candidate.sourceTextRange.start);
    output += candidate.quote ? `${candidate.quote}${replacement}${candidate.quote}` : replacement;
    cursor = candidate.sourceTextRange.end;
  }
  output += text.slice(cursor);
  return output;
}

function failedResult(failureCode: RichPasteFailureCode): RewriteResult {
  return {
    status: "failed",
    assets: [],
    failureCode,
    localMessage: RICH_PASTE_LOCAL_FAILURE_MESSAGES[failureCode],
  };
}

function expandLocalPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function mimeTypeFromExtension(path: string): RichPasteImageMimeType | null {
  const extension = extname(path).toLowerCase();
  for (const type of Object.values(RICH_PASTE_IMAGE_TYPES)) {
    if ((type.extensions as readonly string[]).includes(extension)) {
      return type.mimeType;
    }
  }
  return null;
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

function parseUploadResponse(payload: unknown, index: number): RemotePasteAsset {
  if (
    typeof payload !== "object" ||
    payload === null
  ) {
    throw codedError("Image paste failed", "upload_failed");
  }

  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.terminalPath !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.mimeType !== "string" ||
    typeof candidate.size !== "number" ||
    !isSupportedMimeType(candidate.mimeType)
  ) {
    throw codedError("Image paste failed", "upload_failed");
  }
  return {
    assetId: `paste_${index}`,
    path: candidate.terminalPath,
    homeRelativePath: candidate.path,
    mimeType: candidate.mimeType,
    size: candidate.size,
  };
}

function isSupportedMimeType(value: string): value is RichPasteImageMimeType {
  return Object.values(RICH_PASTE_IMAGE_TYPES).some((type) => type.mimeType === value);
}

function rangesOverlap(left: PasteTextRange, right: PasteTextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function codedError(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, cause });
}
