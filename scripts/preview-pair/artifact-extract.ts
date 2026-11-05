import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, lstat, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { verifyPreviewZipEnd } from "./archive-end.js";
const MAX_FILES = 50_000, MAX_EXPANDED = 6 * 1024 ** 3, MAX_BATCH = 16 * 1024 ** 2;
type Event = { kind: "open"; name: string } | { kind: "data"; name: string; bytes: Uint8Array; final: boolean };
const bad = () => { throw new Error("Preview archive is unavailable"); };
function safePath(name: string) {
  const parts = name.replace(/\/$/, "").split("/");
  return name.length <= 256 && /^[A-Za-z0-9._/-]+$/.test(name) && parts.every(part => part && part !== "." && part !== ".."
    && !part.endsWith(".") && !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part));
}

/** Files stay quarantined until the complete authenticated ZIP digest matches.
 * Paths create regular files only; ZIP symlink attributes are never materialized. */
export async function extractPreviewArtifact(response: Response, options: { sha256: string; sizeBytes: number;
  allowFile(name: string): boolean; signal: AbortSignal; temporaryParent?: string }) {
  if (!response.ok || !response.body) { await response.body?.cancel(); return bad(); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== options.sizeBytes)) { await response.body.cancel(); return bad(); }
  const directory = await mkdtemp(join(options.temporaryParent ?? tmpdir(), "matrix-preview-artifact-"));
  const owner = await lstat(directory);
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== owner.ino || current.dev !== owner.dev) return bad();
    await rm(directory, { recursive: true, force: true });
  })();
  const files: string[] = [], seen = new Set<string>(); // <=MAX_FILES; invocation-local and discarded after use.
  const handles = new Map<string, FileHandle>(); // <=32; closed/evicted on each final frame and on every failure.
  let events: Event[] = [], batch = 0, expanded = 0, count = 0, bytes = 0, tail: Buffer = Buffer.alloc(0);
  const hash = createHash("sha256"), reader = response.body.getReader();
  const enqueue = (event: Event) => {
    if (events.length >= 256) return bad();
    if (event.kind === "data") {
      expanded += event.bytes.length; batch += event.bytes.length;
      if (expanded > MAX_EXPANDED || batch > MAX_BATCH) return bad();
    }
    events.push(event);
  };
  const unzip = new Unzip(file => {
    count++;
    if (count > MAX_FILES || !safePath(file.name) || seen.has(file.name) || !options.allowFile(file.name)
      || file.originalSize !== undefined && file.originalSize > MAX_EXPANDED) return bad();
    seen.add(file.name);
    const folder = file.name.endsWith("/");
    if (!folder) { files.push(file.name); enqueue({ kind: "open", name: file.name }); }
    file.ondata = (error, data, final) => {
      if (error) throw error;
      if (folder) { if (data.length) bad(); return; }
      enqueue({ kind: "data", name: file.name, bytes: Uint8Array.from(data), final });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  async function flush() {
    for (const event of events) {
      options.signal.throwIfAborted();
      if (event.kind === "open") {
        if (handles.size >= 32) return bad();
        const parts = event.name.split("/"); parts.pop();
        if (parts.length) await mkdir(join(directory, ...parts), { recursive: true, mode: 0o700 });
        handles.set(event.name, await open(join(directory, event.name), "wx", 0o600));
      } else {
        const handle = handles.get(event.name); if (!handle) return bad();
        let offset = 0;
        while (offset < event.bytes.length) {
          const result = await handle.write(event.bytes, offset, event.bytes.length - offset);
          if (!result.bytesWritten) return bad(); offset += result.bytesWritten;
        }
        if (event.final) { await handle.close(); handles.delete(event.name); }
      }
    }
    events = []; batch = 0;
  }
  let accepted = false;
  try {
    for (;;) {
      options.signal.throwIfAborted();
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > options.sizeBytes) return bad();
      hash.update(next.value);
      tail = Buffer.concat([tail, next.value.subarray(Math.max(0, next.value.length - 65_633))]).subarray(-65_633);
      for (let offset = 0; offset < next.value.length; offset += 16 * 1024) {
        unzip.push(next.value.subarray(offset, offset + 16 * 1024)); await flush();
      }
    }
    unzip.push(new Uint8Array(), true); await flush();
    if (!files.length || handles.size || bytes !== options.sizeBytes || hash.digest("hex") !== options.sha256) return bad();
    verifyPreviewZipEnd(tail, bytes, count);
    accepted = true;
    return { directory, files, dispose };
  } finally {
    try { await reader.cancel(); }
    catch (error: unknown) { console.warn("[preview-pair] artifact stream close deferred", error instanceof Error ? error.name : "UnknownError"); }
    finally { reader.releaseLock(); }
    const closed = await Promise.allSettled([...handles.values()].map(handle => handle.close())); handles.clear();
    for (const result of closed) if (result.status === "rejected") console.warn("[preview-pair] artifact close deferred",
      result.reason instanceof Error ? result.reason.name : "UnknownError");
    if (!accepted) await dispose();
  }
}
