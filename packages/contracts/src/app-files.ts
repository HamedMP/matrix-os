import { z } from "zod/v4";
import { AppIdentitySchema, MAX_APP_BRIDGE_REPLY_BYTES, MAX_APP_CAPABILITY_BYTES } from "#app-capabilities";

/**
 * Contract for app access to files in the owner's home.
 *
 * One route, `POST /api/bridge/files`, takes `{ app, input }`. The trusted host
 * (the shell, or the Electron main process) supplies `app`; an app never does.
 * `input` is a union keyed by `kind`. File content travels as base64 inside
 * JSON because the app bridge carries JSON only.
 */
export const APP_FILES_BRIDGE_PATH = "/api/bridge/files";
/** Electron IPC channel for the same request, next to `native-app:capability`. */
export const APP_FILES_CHANNEL = "native-app:files";
/** An app must list this in `permissions` in its matrix.json to use the route. */
export const APP_FILES_PERMISSION = "files";
/** Budget for one request, including upload and download of a 10 MiB file. */
export const APP_FILE_TIMEOUT_MS = 60_000;

/** Largest file an app may read or write, in decoded bytes. */
export const APP_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Length of the base64 text of a file of exactly `APP_FILE_MAX_BYTES`. */
export const APP_FILE_MAX_BASE64_CHARS = Math.ceil(APP_FILE_MAX_BYTES / 3) * 4;
export const APP_FILE_PATH_MAX_CHARS = 4096;
export const APP_FILE_NAME_MAX_CHARS = 255;
export const APP_FILE_LIST_MAX_ENTRIES = 500;
/** Room for everything around the content: identity, kind, version, MIME type
 * and one path whose every character is JSON-escaped to six bytes. */
const APP_FILE_ENVELOPE_BYTES = 64 * 1024;
/** JSON body cap of a `files.write` request. Use it for `bodyLimit` on the route. */
export const MAX_APP_FILE_REQUEST_BYTES = APP_FILE_MAX_BASE64_CHARS + APP_FILE_ENVELOPE_BYTES;
/** JSON body cap of a `files.read` reply. */
export const MAX_APP_FILE_REPLY_BYTES = APP_FILE_MAX_BASE64_CHARS + APP_FILE_ENVELOPE_BYTES;
/** JSON body cap of a `files.list` reply. The gateway stops adding entries and
 * sets `truncated` before a listing would exceed it. */
export const MAX_APP_FILE_LIST_REPLY_BYTES = 8 * 1024 * 1024;

export const APP_FILE_KINDS = ["files.list", "files.stat", "files.read", "files.write", "files.mkdir"] as const;
export type AppFileKind = (typeof APP_FILE_KINDS)[number];

/** Request body cap by kind. Only a write carries content. */
export function appFileRequestBytes(kind: AppFileKind): number {
  return kind === "files.write" ? MAX_APP_FILE_REQUEST_BYTES : MAX_APP_CAPABILITY_BYTES;
}
/** Reply body cap by kind. Only a read carries content. */
export function appFileReplyBytes(kind: AppFileKind): number {
  if (kind === "files.read") return MAX_APP_FILE_REPLY_BYTES;
  return kind === "files.list" ? MAX_APP_FILE_LIST_REPLY_BYTES : MAX_APP_BRIDGE_REPLY_BYTES;
}

/**
 * Path rules. A path is relative to the owner's home and uses forward slashes.
 * It has 1 to 4096 characters, no NUL, no backslash, no leading or trailing
 * slash, and no empty, `.` or `..` segment. These rules are syntax only: the
 * gateway still resolves the path with `resolveExistingFileApiPath` or
 * `resolveWritableFileApiPath`, which refuse symlinks and protected subtrees.
 */
export function isAppFilePath(value: string): boolean {
  if (value.length < 1 || value.length > APP_FILE_PATH_MAX_CHARS) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
export const AppFilePathSchema = z.string().min(1).max(APP_FILE_PATH_MAX_CHARS).refine(isAppFilePath);

/** Top-level owner and tool state the app file route always refuses, besides every dot directory. */
export const APP_FILE_PROTECTED_TOP_LEVEL = Object.freeze(["system", "agents"] as const);
/** Subtrees the gateway File API hides from every client. */
export const APP_FILE_DENIED_PREFIXES = Object.freeze(["data/browser-profiles", "data/app-gallery-staging"] as const);

/**
 * True when `path` is a valid app path outside the subtrees the app file
 * route refuses: dot directories, `system/`, `agents/` and the denied
 * prefixes. This is a client hint for routing (for example Files choosing
 * between an app and Preview); the gateway stays the authority and also
 * refuses symlinks.
 */
export function isAppReachableFilePath(path: string): boolean {
  if (!isAppFilePath(path)) return false;
  const first = path.slice(0, path.includes("/") ? path.indexOf("/") : path.length);
  if (first.startsWith(".") || (APP_FILE_PROTECTED_TOP_LEVEL as readonly string[]).includes(first)) return false;
  return !APP_FILE_DENIED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
/** The home root, valid only as the `dir` of a listing. */
export const APP_FILE_HOME_DIR = "";
export const AppFileDirSchema = z.union([z.literal(APP_FILE_HOME_DIR), AppFilePathSchema]);

/**
 * A version is an opaque token for one state of a file. The gateway computes
 * it from the file's size and modification time with `appFileVersion`; apps
 * only store it and send it back as `ifVersion`. Two states with the same size
 * and the same modification time are indistinguishable, so the gateway stats
 * and compares inside the same critical section as the write.
 */
export const AppFileVersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
export function appFileVersion(size: number | bigint, mtimeNs: bigint): string {
  // BigInt() calls, not `0n` literals: the shell compiles this module for ES2017.
  const zero = BigInt(0);
  const bytes = typeof size === "bigint" ? size : Number.isSafeInteger(size) ? BigInt(size) : BigInt(-1);
  if (bytes < zero || mtimeNs < zero) throw new RangeError("Invalid file version input");
  return `v1.${bytes.toString(36)}.${mtimeNs.toString(36)}`;
}

/** Decoded byte length of canonical base64 text, or -1 when the text is not
 * canonical base64 (standard alphabet, padded, no whitespace). */
export function appFileBase64ByteLength(text: string): number {
  const length = text.length;
  if (length % 4 !== 0) return -1;
  const padding = length === 0 ? 0 : text.charCodeAt(length - 1) !== 61 ? 0 : text.charCodeAt(length - 2) !== 61 ? 1 : 2;
  for (let index = 0; index < length - padding; index++) {
    const code = text.charCodeAt(index);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!valid) return -1;
  }
  return (length / 4) * 3 - padding;
}
export function encodeAppFileBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}
export function decodeAppFileBase64(text: string): Uint8Array {
  const size = appFileBase64ByteLength(text);
  if (size < 0) throw new RangeError("Invalid base64 content");
  const binary = atob(text);
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function isBoundedContent(text: string): boolean {
  const size = appFileBase64ByteLength(text);
  return size >= 0 && size <= APP_FILE_MAX_BYTES;
}
export const AppFileContentBase64Schema = z.string().max(APP_FILE_MAX_BASE64_CHARS).refine(isBoundedContent);

export const AppFileListInputSchema = z.strictObject({
  kind: z.literal("files.list"),
  dir: AppFileDirSchema,
  limit: z.number().int().min(1).max(APP_FILE_LIST_MAX_ENTRIES).default(APP_FILE_LIST_MAX_ENTRIES),
});
export const AppFileStatInputSchema = z.strictObject({ kind: z.literal("files.stat"), path: AppFilePathSchema });
export const AppFileReadInputSchema = z.strictObject({ kind: z.literal("files.read"), path: AppFilePathSchema });
export const AppFileWriteInputSchema = z.strictObject({
  kind: z.literal("files.write"),
  path: AppFilePathSchema,
  contentBase64: AppFileContentBase64Schema,
  /** The version the app last read. `null` means the file must not exist yet. */
  ifVersion: AppFileVersionSchema.nullable(),
  /** Create missing parent directories. Without it a missing parent is `not_found`. */
  createParents: z.boolean().optional(),
});
/** Creates the directory and any missing parents. An existing directory is success. */
export const AppFileMkdirInputSchema = z.strictObject({ kind: z.literal("files.mkdir"), path: AppFilePathSchema });

export const AppFileInputSchema = z.discriminatedUnion("kind", [
  AppFileListInputSchema,
  AppFileStatInputSchema,
  AppFileReadInputSchema,
  AppFileWriteInputSchema,
  AppFileMkdirInputSchema,
]);
export type AppFileInput = z.infer<typeof AppFileInputSchema>;
/** App identity is supplied by the trusted host, never by the app. */
export const AppFileRequestSchema = z.strictObject({ app: AppIdentitySchema, input: AppFileInputSchema });
export type AppFileRequest = z.infer<typeof AppFileRequestSchema>;

const Size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ReadableSize = Size.max(APP_FILE_MAX_BYTES);
const ModifiedAt = z.iso.datetime();
const EntryName = z.string().min(1).max(APP_FILE_NAME_MAX_CHARS).refine((name) => !name.includes("/") && !name.includes("\0"));
const MimeType = z.string().min(3).max(255).regex(/^[^\s/;]+\/[^\s/;]+(?:;[\x20-\x7e]*)?$/);

/** `size` is 0 for a directory. Symlinks and protected entries are never listed. */
export const AppFileEntrySchema = z.strictObject({
  name: EntryName,
  path: AppFilePathSchema,
  kind: z.enum(["file", "dir"]),
  size: Size,
  modifiedAt: ModifiedAt,
});
export type AppFileEntry = z.infer<typeof AppFileEntrySchema>;
/** Directories first, then by name. `truncated` is true when entries were left out. */
export const AppFileListReplySchema = z.strictObject({
  entries: z.array(AppFileEntrySchema).max(APP_FILE_LIST_MAX_ENTRIES),
  truncated: z.boolean().default(false),
});
export type AppFileListReply = z.infer<typeof AppFileListReplySchema>;
/** Describes a regular file of any size; a file above the cap can be stat-ed but not read. */
export const AppFileStatReplySchema = z.strictObject({ path: AppFilePathSchema, size: Size, modifiedAt: ModifiedAt, version: AppFileVersionSchema });
export type AppFileStatReply = z.infer<typeof AppFileStatReplySchema>;
export const AppFileReadReplySchema = z.strictObject({
  path: AppFilePathSchema,
  contentBase64: AppFileContentBase64Schema,
  size: ReadableSize,
  version: AppFileVersionSchema,
  mimeType: MimeType,
}).refine((reply) => appFileBase64ByteLength(reply.contentBase64) === reply.size);
export type AppFileReadReply = z.infer<typeof AppFileReadReplySchema>;
export const AppFileWriteReplySchema = z.strictObject({ path: AppFilePathSchema, version: AppFileVersionSchema, size: ReadableSize, modifiedAt: ModifiedAt });
export type AppFileWriteReply = z.infer<typeof AppFileWriteReplySchema>;
export const AppFileMkdirReplySchema = z.strictObject({ path: AppFilePathSchema });
export type AppFileMkdirReply = z.infer<typeof AppFileMkdirReplySchema>;

export const APP_FILE_ERROR_CODES = ["not_found", "forbidden", "too_large", "version_conflict", "invalid_request", "unavailable"] as const;
export const AppFileErrorCodeSchema = z.enum(APP_FILE_ERROR_CODES);
export type AppFileErrorCode = z.infer<typeof AppFileErrorCodeSchema>;
export const APP_FILE_ERROR_STATUS = Object.freeze({
  not_found: 404,
  forbidden: 403,
  too_large: 413,
  version_conflict: 409,
  invalid_request: 400,
  unavailable: 503,
} as const satisfies Record<AppFileErrorCode, number>);
/** The only messages a client ever sees. Detail stays in the gateway log. */
export const APP_FILE_ERROR_MESSAGES: Readonly<Record<AppFileErrorCode, string>> = Object.freeze({
  not_found: "File not found",
  forbidden: "File access is not allowed",
  too_large: "File is too large",
  version_conflict: "File changed since it was opened",
  invalid_request: "Invalid file request",
  unavailable: "File access is unavailable",
});
export const AppFileErrorBodySchema = z.strictObject({
  error: z.strictObject({ code: AppFileErrorCodeSchema, message: z.string().min(1).max(200) }),
});
export type AppFileErrorBody = z.infer<typeof AppFileErrorBodySchema>;
export function appFileErrorBody(code: AppFileErrorCode): AppFileErrorBody {
  return { error: { code, message: APP_FILE_ERROR_MESSAGES[code] } };
}
/** For a host that has a status but no valid error body. Anything unexpected is `unavailable`. */
export function appFileErrorCodeForStatus(status: number): AppFileErrorCode {
  return APP_FILE_ERROR_CODES.find((code) => APP_FILE_ERROR_STATUS[code] === status) ?? "unavailable";
}

/** The error every `MatrixOS.files` method rejects with. */
export class BridgeFileError extends Error {
  readonly code: AppFileErrorCode;
  constructor(code: AppFileErrorCode) {
    super(APP_FILE_ERROR_MESSAGES[code]);
    this.name = "BridgeFileError";
    this.code = code;
  }
}
/** Structural check: an error raised by the injected bridge script comes from
 * another realm, so `instanceof` does not hold for it. */
export function isBridgeFileError(value: unknown): value is { name: "BridgeFileError"; code: AppFileErrorCode; message: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; code?: unknown };
  return candidate.name === "BridgeFileError" && AppFileErrorCodeSchema.safeParse(candidate.code).success;
}

export interface AppFileContent { path: string; bytes: Uint8Array; size: number; version: string; mimeType: string }
export interface AppFileWriteOptions { ifVersion: string | null; createParents?: boolean }

/**
 * Same API in a sandboxed web iframe and an Electron app view. `invoke` sends
 * one validated input to the host and resolves with the JSON body of the
 * gateway reply, whether that is a result or an `{ error }` body. The client
 * converts bytes to and from base64 and turns every failure into a
 * `BridgeFileError` that carries a generic message only.
 */
export function createAppFilesClient(invoke: (input: AppFileInput) => Promise<unknown>) {
  async function request<T>(input: unknown, reply: z.ZodType<T>): Promise<T> {
    const parsed = AppFileInputSchema.safeParse(input);
    if (!parsed.success) throw new BridgeFileError("invalid_request");
    let body: unknown;
    try { body = await invoke(parsed.data); }
    catch (error) {
      if (isBridgeFileError(error)) throw new BridgeFileError(error.code);
      console.warn("[app-files] request failed", error instanceof Error ? error.name : "UnknownError");
      throw new BridgeFileError("unavailable");
    }
    const failure = AppFileErrorBodySchema.safeParse(body);
    if (failure.success) throw new BridgeFileError(failure.data.error.code);
    const result = reply.safeParse(body);
    if (!result.success) throw new BridgeFileError("unavailable");
    return result.data;
  }
  return Object.freeze({
    list: (dir: string, options: { limit?: number } = {}): Promise<AppFileListReply> =>
      request({ kind: "files.list", dir, ...(options.limit !== undefined ? { limit: options.limit } : {}) }, AppFileListReplySchema),
    stat: (path: string): Promise<AppFileStatReply> => request({ kind: "files.stat", path }, AppFileStatReplySchema),
    read: async (path: string): Promise<AppFileContent> => {
      const reply = await request({ kind: "files.read", path }, AppFileReadReplySchema);
      return { path: reply.path, bytes: decodeAppFileBase64(reply.contentBase64), size: reply.size, version: reply.version, mimeType: reply.mimeType };
    },
    write: async (path: string, bytes: Uint8Array, options: AppFileWriteOptions): Promise<AppFileWriteReply> => {
      if (!(bytes instanceof Uint8Array) || !options || options.ifVersion === undefined) throw new BridgeFileError("invalid_request");
      if (bytes.byteLength > APP_FILE_MAX_BYTES) throw new BridgeFileError("too_large");
      return request({
        kind: "files.write", path, contentBase64: encodeAppFileBase64(bytes), ifVersion: options.ifVersion,
        ...(options.createParents !== undefined ? { createParents: options.createParents } : {}),
      }, AppFileWriteReplySchema);
    },
    mkdir: (path: string): Promise<AppFileMkdirReply> => request({ kind: "files.mkdir", path }, AppFileMkdirReplySchema),
  });
}
export type AppFilesClient = ReturnType<typeof createAppFilesClient>;
