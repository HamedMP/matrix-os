import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/** `matrix-app-bundle/1`: deterministic gzip+JSON app bundles (spec 631, contracts/bundle-format.md). Node only. */

export const APP_BUNDLE_FORMAT = "matrix-app-bundle/1";
export const APP_BUNDLE_LIMITS = Object.freeze({
  maxFiles: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
  maxCompressedBytes: 16 * 1024 * 1024,
  maxInflatedBytes: 40 * 1024 * 1024,
  maxPathBytes: 240,
  maxSegments: 12,
});

export type AppBundleKind = "source" | "dist";
export type AppBundleErrorCode =
  | "invalid_format" | "invalid_path" | "excluded_path" | "hash_mismatch" | "limit_exceeded" | "missing_required_file";

export class AppBundleError extends Error {
  constructor(readonly code: AppBundleErrorCode, message = "Invalid app bundle") {
    super(message);
    this.name = "AppBundleError";
  }
}

export interface AppBundleEntry { path: string; size: number; sha256: string }
export interface DecodedAppBundle { kind: AppBundleKind; files: Map<string, Buffer>; entries: AppBundleEntry[] }

const SEGMENT = /^[A-Za-z0-9._@+-]{1,128}$/;
const REQUIRED: Record<AppBundleKind, readonly string[]> = {
  source: ["matrix.json", "package.json", "pnpm-lock.yaml", "index.html"],
  dist: ["index.html"],
};
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", ".matrix-store"]);

export function validateBundlePath(path: string, kind: AppBundleKind): void {
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path) > APP_BUNDLE_LIMITS.maxPathBytes) {
    throw new AppBundleError("invalid_path");
  }
  const segments = path.split("/");
  if (segments.length > APP_BUNDLE_LIMITS.maxSegments) throw new AppBundleError("invalid_path");
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !SEGMENT.test(segment)) throw new AppBundleError("invalid_path");
  }
  if (kind !== "source") return;
  const name = segments[segments.length - 1];
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))
    || segments[0] === "dist"
    || name.startsWith(".env")
    || name === ".build-stamp"
    || name === ".build.log"
    || name.endsWith(".log")) {
    throw new AppBundleError("excluded_path");
  }
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const byPath = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function checkLimits(entries: readonly { path: string; size: number }[], kind: AppBundleKind): void {
  if (entries.length > APP_BUNDLE_LIMITS.maxFiles) throw new AppBundleError("limit_exceeded");
  let total = 0;
  for (const entry of entries) {
    if (entry.size > APP_BUNDLE_LIMITS.maxFileBytes) throw new AppBundleError("limit_exceeded");
    total += entry.size;
    if (total > APP_BUNDLE_LIMITS.maxTotalBytes) throw new AppBundleError("limit_exceeded");
  }
  const paths = new Set(entries.map(entry => entry.path));
  for (const required of REQUIRED[kind]) {
    if (!paths.has(required)) throw new AppBundleError("missing_required_file");
  }
}

export function encodeAppBundle(kind: AppBundleKind, files: ReadonlyMap<string, Buffer>): Buffer {
  const paths = [...files.keys()].sort(byPath);
  for (const path of paths) validateBundlePath(path, kind);
  const entries = paths.map(path => ({ path, size: files.get(path)!.length }));
  checkLimits(entries, kind);
  const body = paths.map(path => {
    const data = files.get(path)!;
    return `{"path":${JSON.stringify(path)},"size":${data.length},"sha256":"${sha256(data)}","data":"${data.toString("base64")}"}`;
  }).join(",");
  const json = `{"format":"${APP_BUNDLE_FORMAT}","kind":"${kind}","files":[${body}]}`;
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  // Zero mtime and set OS=unknown so identical files yield identical bytes.
  gz.writeUInt32LE(0, 4);
  gz[9] = 0xff;
  if (gz.length > APP_BUNDLE_LIMITS.maxCompressedBytes) throw new AppBundleError("limit_exceeded");
  return gz;
}

export function bundleDigest(bundle: Buffer): string {
  return sha256(bundle);
}

function inflate(bytes: Buffer): Buffer {
  if (bytes.length > APP_BUNDLE_LIMITS.maxCompressedBytes) throw new AppBundleError("limit_exceeded");
  try {
    return gunzipSync(bytes, { maxOutputLength: APP_BUNDLE_LIMITS.maxInflatedBytes });
  } catch (error: unknown) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new AppBundleError("limit_exceeded");
    }
    if (error instanceof Error && (error as NodeJS.ErrnoException).code?.startsWith("Z_")) {
      throw new AppBundleError("invalid_format");
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeAppBundle(bytes: Buffer, options: { kind: AppBundleKind }): DecodedAppBundle {
  const inflated = inflate(bytes);
  let document: unknown;
  try {
    document = JSON.parse(inflated.toString("utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new AppBundleError("invalid_format");
    throw error;
  }
  if (!isRecord(document) || Object.keys(document).length !== 3
    || document.format !== APP_BUNDLE_FORMAT || document.kind !== options.kind || !Array.isArray(document.files)) {
    throw new AppBundleError("invalid_format");
  }
  const rawFiles = document.files as unknown[];
  if (rawFiles.length > APP_BUNDLE_LIMITS.maxFiles) throw new AppBundleError("limit_exceeded");
  const files = new Map<string, Buffer>();
  const entries: AppBundleEntry[] = [];
  let previous: string | null = null;
  let total = 0;
  for (const raw of rawFiles) {
    if (!isRecord(raw) || Object.keys(raw).length !== 4 || typeof raw.path !== "string" || typeof raw.data !== "string"
      || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)
      || typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0) {
      throw new AppBundleError("invalid_format");
    }
    validateBundlePath(raw.path, options.kind);
    if (previous !== null && byPath(previous, raw.path) >= 0) throw new AppBundleError("invalid_format");
    previous = raw.path;
    if (raw.size > APP_BUNDLE_LIMITS.maxFileBytes) throw new AppBundleError("limit_exceeded");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) throw new AppBundleError("invalid_format");
    const data = Buffer.from(raw.data, "base64");
    if (data.length !== raw.size || sha256(data) !== raw.sha256) throw new AppBundleError("hash_mismatch");
    total += data.length;
    if (total > APP_BUNDLE_LIMITS.maxTotalBytes) throw new AppBundleError("limit_exceeded");
    files.set(raw.path, data);
    entries.push({ path: raw.path, size: raw.size, sha256: raw.sha256 });
  }
  checkLimits(entries, options.kind);
  return { kind: options.kind, files, entries };
}

