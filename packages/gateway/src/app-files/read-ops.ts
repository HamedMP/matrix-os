import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  APP_FILE_HOME_DIR, APP_FILE_MAX_BYTES, APP_FILE_NAME_MAX_CHARS, MAX_APP_FILE_LIST_REPLY_BYTES,
  appFileVersion, isAppFilePath,
  type AppFileEntry, type AppFileListReply, type AppFileReadReply, type AppFileStatReply,
} from "@matrix-os/contracts/app-files";
import { getMimeType } from "../file-utils.js";
import { AppFileError } from "./errors.js";
import { isListableChild, lstatOrNull, resolveExistingAppFilePath } from "./paths.js";

/** Directory entries examined per listing. Beyond this the listing is truncated. */
export const APP_FILE_LIST_SCAN_LIMIT = 10_000;
const LIST_STAT_BATCH = 16;
/** `{"entries":[],"truncated":true}` plus slack. */
const LIST_REPLY_OVERHEAD_BYTES = 64;

export function modifiedAtFromMs(mtimeMs: number | bigint): string {
  return new Date(Number(mtimeMs)).toISOString();
}

interface Candidate { name: string; path: string; kind: "file" | "dir" }

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, "en");
}

async function scanDirectory(homePath: string, dirPath: string, dir: string): Promise<{ candidates: Candidate[]; truncated: boolean }> {
  const candidates: Candidate[] = [];
  let scanned = 0;
  let truncated = false;
  const handle = await opendir(dirPath, { bufferSize: 64 });
  for await (const entry of handle) {
    if (++scanned > APP_FILE_LIST_SCAN_LIMIT) { truncated = true; break; }
    if (entry.isSymbolicLink()) continue;
    const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
    if (!kind || entry.name.length > APP_FILE_NAME_MAX_CHARS) continue;
    const path = dir === APP_FILE_HOME_DIR ? entry.name : `${dir}/${entry.name}`;
    if (!isAppFilePath(path) || !isListableChild(homePath, path)) continue;
    candidates.push({ name: entry.name, path, kind });
  }
  return { candidates, truncated };
}

async function describeCandidate(dirPath: string, candidate: Candidate): Promise<AppFileEntry | null> {
  // lstat never follows a link; an entry replaced by a link or removed since the scan is skipped.
  const info = await lstatOrNull(join(dirPath, candidate.name));
  if (!info) return null;
  const kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : null;
  if (kind !== candidate.kind) return null;
  return { name: candidate.name, path: candidate.path, kind, size: kind === "dir" ? 0 : info.size, modifiedAt: modifiedAtFromMs(info.mtimeMs) };
}

/** Bounded, symlink-free listing: directories first, then by name. */
export async function listAppFiles(homePath: string, dir: string, limit: number): Promise<AppFileListReply> {
  const dirPath = dir === APP_FILE_HOME_DIR ? resolve(homePath) : await resolveExistingAppFilePath(homePath, dir);
  const info = await lstat(dirPath);
  if (!info.isDirectory()) throw new AppFileError("invalid_request", "not a directory");
  const scan = await scanDirectory(homePath, dirPath, dir);
  scan.candidates.sort(compareCandidates);
  const entries: AppFileEntry[] = [];
  let bytes = LIST_REPLY_OVERHEAD_BYTES;
  let truncated = scan.truncated;
  let index = 0;
  outer: while (index < scan.candidates.length) {
    const batch = scan.candidates.slice(index, index + LIST_STAT_BATCH);
    index += batch.length;
    const described = await Promise.all(batch.map((candidate) => describeCandidate(dirPath, candidate)));
    for (let offset = 0; offset < described.length; offset++) {
      const entry = described[offset];
      if (!entry) continue;
      const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (entries.length >= limit || bytes + entryBytes > MAX_APP_FILE_LIST_REPLY_BYTES) {
        truncated = true;
        break outer;
      }
      entries.push(entry);
      bytes += entryBytes;
    }
    if (entries.length >= limit && index < scan.candidates.length) { truncated = true; break; }
  }
  return { entries, truncated };
}

/** Regular files only. Reports the true size, even above the read cap. */
export async function statAppFile(homePath: string, path: string): Promise<AppFileStatReply> {
  const target = await resolveExistingAppFilePath(homePath, path);
  const info = await lstat(target, { bigint: true });
  if (!info.isFile()) throw new AppFileError("invalid_request", "not a file");
  return { path, size: Number(info.size), modifiedAt: modifiedAtFromMs(info.mtimeMs), version: appFileVersion(info.size, info.mtimeNs) };
}

/**
 * Reads through one no-follow descriptor so the checked file is the read file.
 * O_NONBLOCK keeps a named pipe from holding the open until a writer appears;
 * the descriptor check then refuses it.
 */
export async function readAppFile(homePath: string, path: string): Promise<AppFileReadReply> {
  const target = await resolveExistingAppFilePath(homePath, path);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new AppFileError("invalid_request", "not a file");
    if (before.size > BigInt(APP_FILE_MAX_BYTES)) throw new AppFileError("too_large");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > APP_FILE_MAX_BYTES) throw new AppFileError("too_large");
    // A size change during the read means the bytes and the version disagree.
    if (BigInt(total) !== before.size) throw new AppFileError("unavailable", "file changed during read");
    const content = buffer.subarray(0, total);
    return {
      path,
      contentBase64: content.toString("base64"),
      size: total,
      version: appFileVersion(before.size, before.mtimeNs),
      mimeType: getMimeType(extname(path) || ".bin"),
    };
  } finally {
    await handle.close();
  }
}
