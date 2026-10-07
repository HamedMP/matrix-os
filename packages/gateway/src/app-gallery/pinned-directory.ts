import { constants } from "node:fs";
import { mkdir, open, opendir, type FileHandle } from "node:fs/promises";
import { basename, dirname, parse, resolve, sep } from "node:path";

export class GalleryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); }
}
export function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function leaf(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0") || Buffer.byteLength(name) > 255) throw new GalleryError(503, "Invalid filesystem component");
  return name;
}
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Linux directory capabilities. Child operations never re-resolve a mutable ancestor path. */
export class PinnedDirectory {
  constructor(private readonly handle: FileHandle) {}
  get path(): string { return `/proc/self/fd/${this.handle.fd}`; }
  async close(): Promise<void> { await this.handle.close(); }
  async identity(): Promise<{ dev: number; ino: number }> {
    const info = await this.handle.stat(); return { dev: info.dev, ino: info.ino };
  }
  async isPrivate(): Promise<boolean> {
    const info = await this.handle.stat();
    return info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.();
  }
  async child(name: string): Promise<PinnedDirectory> {
    return new PinnedDirectory(await open(`${this.path}/${leaf(name)}`, DIRECTORY_FLAGS));
  }
  async createChild(name: string, mode = 0o700): Promise<PinnedDirectory> {
    await mkdir(`${this.path}/${leaf(name)}`, { mode });
    return this.child(name);
  }
  async ensureChild(name: string, mode = 0o700): Promise<PinnedDirectory> {
    try { return await this.createChild(name, mode); }
    catch (error) { if (!isFsError(error, "EEXIST")) throw error; return this.child(name); }
  }
  async entries() { return opendir(this.path); }
  async openFile(name: string, flags: number): Promise<FileHandle> {
    return open(`${this.path}/${leaf(name)}`, flags | constants.O_NOFOLLOW, 0o600);
  }
  async readFile(name: string, maxBytes: number): Promise<Buffer> {
    const handle = await this.openFile(name, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new GalleryError(503, "Invalid file");
      const bytes = Buffer.alloc(maxBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, null);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      if (count > maxBytes) throw new GalleryError(503, "File too large");
      // Template traversal retains these buffers. A subarray would retain the
      // entire read budget for every small file instead of its actual content.
      return Buffer.from(bytes.subarray(0, count));
    } finally { await handle.close(); }
  }
}

export async function pinDirectory(path: string): Promise<PinnedDirectory> {
  // Node has no portable openat API; /dev/fd does not provide this capability on macOS.
  if (process.platform !== "linux") throw new GalleryError(503, "Safe gallery filesystem capabilities are unavailable");
  const absolute = resolve(path);
  let current = new PinnedDirectory(await open(parse(absolute).root, DIRECTORY_FLAGS));
  try {
    for (const component of absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean)) {
      const previous = current;
      current = await previous.child(component);
      await previous.close();
    }
    return current;
  } catch (error) { await current.close(); throw error; }
}
export async function readLimited(path: string, maxBytes: number): Promise<Buffer> {
  const parent = await pinDirectory(dirname(path));
  try { return await parent.readFile(basename(path), maxBytes); }
  finally { await parent.close(); }
}
