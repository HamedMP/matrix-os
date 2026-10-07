import { constants } from "node:fs";
import { link, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { PinnedDirectory, pinDirectory, GalleryError, isFsError } from "./pinned-directory.js";
export { GalleryError, isFsError, pinDirectory, readLimited } from "./pinned-directory.js";

export interface GalleryLimits { maxFileBytes: number; maxTotalBytes: number; maxFiles: number; maxEntries: number; maxCatalogBytes: number }
export const DEFAULT_LIMITS: GalleryLimits = { maxFileBytes: 4_194_304, maxTotalBytes: 25_165_824, maxFiles: 256, maxEntries: 512, maxCatalogBytes: 262_144 };
export const STAGING_SLOTS = 4;

export async function readTemplate(templatePath: string, limits: GalleryLimits): Promise<Map<string, Buffer>> {
  const root = await pinDirectory(templatePath);
  const files = new Map<string, Buffer>(); // Request-scoped and capped below.
  let entries = 0, total = 0;
  async function visit(directory: PinnedDirectory, prefix: string, depth: number): Promise<void> {
    if (depth > 16) throw new GalleryError(503, "Template nesting limit");
    for await (const entry of await directory.entries()) {
      if (++entries > limits.maxEntries) throw new GalleryError(503, "Template entry limit");
      if (entry.isSymbolicLink()) throw new GalleryError(503, "Template contains symlink");
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const child = await directory.child(entry.name);
        try { await visit(child, key, depth + 1); } finally { await child.close(); }
      } else {
        if (!entry.isFile()) throw new GalleryError(503, "Invalid template entry");
        if (key === "matrix.json") continue;
        if (key.endsWith("/matrix.json")) throw new GalleryError(503, "Nested app manifests are forbidden");
        if (files.size >= limits.maxFiles) throw new GalleryError(503, "Template file limit");
        const bytes = await directory.readFile(entry.name, Math.min(limits.maxFileBytes, limits.maxTotalBytes - total));
        total += bytes.length; files.set(key, bytes);
      }
    }
  }
  try { await visit(root, "", 0); return files; } finally { await root.close(); }
}

/** This namespace is denied by the owner file APIs and uses mode0700; ordinary apps never see it. */
export class PrivateStage {
  private readonly names: string[] = []; // At most256 template files plus one manifest.
  constructor(readonly directory: PinnedDirectory, private readonly root: PinnedDirectory, private readonly slot: string) {}
  async write(bytes: Buffer): Promise<string> {
    if (this.names.length >= DEFAULT_LIMITS.maxFiles + 1) throw new GalleryError(503, "Stage file limit");
    const name = `file-${this.names.length}`;
    const handle = await this.directory.openFile(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    this.names.push(name); // Track immediately after exclusive creation, including partial-write failures.
    try {
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, written);
        if (result.bytesWritten === 0) throw new GalleryError(503, "File write made no progress");
        written += result.bytesWritten;
      }
    } finally { await closeFile(handle); }
    return name;
  }
  async publish(name: string, destination: PinnedDirectory, leaf: string): Promise<void> {
    if (!this.names.includes(name) || !leaf || leaf === "." || leaf === ".." || /[/\\\0]/.test(leaf)) throw new GalleryError(503, "Invalid publication");
    // Both parent directories stay pinned. link is exclusive even for an existing destination symlink.
    await link(`${this.directory.path}/${name}`, `${destination.path}/${leaf}`);
  }
  async release(): Promise<void> {
    let clean = true;
    for (const name of this.names) {
      try { await unlink(`${this.directory.path}/${name}`); }
      catch (error) { if (!isFsError(error, "ENOENT")) { clean = false; console.warn("[app-gallery] Private stage requires recovery", error); } }
    }
    try { await this.directory.close(); }
    catch (error) { clean = false; console.warn("[app-gallery] Failed to close private stage", error); }
    if (clean) {
      try { await rmdir(`${this.root.path}/${this.slot}`); }
      catch (error) { if (!isFsError(error, "ENOENT")) console.warn("[app-gallery] Retained private stage for recovery", error); }
    }
    await this.root.close();
  }
}
async function closeFile(handle: FileHandle): Promise<void> {
  try { await handle.close(); }
  catch (error) { console.warn("[app-gallery] Failed to close staging file", error); throw error; }
}
export async function createPrivateStage(home: PinnedDirectory): Promise<PrivateStage> {
  const data = await home.ensureChild("data");
  let root: PinnedDirectory;
  try { root = await data.ensureChild("app-gallery-staging"); } finally { await data.close(); }
  try {
    if (!await root.isPrivate()) throw new GalleryError(503, "Invalid private staging permissions");
    for (let index = 0; index < STAGING_SLOTS; index++) {
      const slot = `slot-${index}`;
      try { return new PrivateStage(await root.createChild(slot), root, slot); }
      catch (error) { if (!isFsError(error, "EEXIST")) throw error; }
    }
    throw new GalleryError(503, "Private staging requires recovery");
  } catch (error) { await root.close(); throw error; }
}
