import { DownloadPathSchema, safeDownloadFilename } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { zipSync, type Zippable } from "fflate";

export interface ArchiveEntry { path: string; kind: "file" | "directory" }
const MAX_ENTRIES = 1000;
const MAX_BYTES = 50 * 1024 * 1024;

const ArchiveListingSchema = z.strictObject({
  complete: z.literal(true),
  entries: z.array(z.strictObject({ path: DownloadPathSchema, kind: z.enum(["file", "directory"]) })).max(MAX_ENTRIES),
});
export function parseArchiveListing(value: unknown): ArchiveEntry[] { return ArchiveListingSchema.parse(value).entries; }

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function createDirectoryArchive(root: string, transport: {
  list(path: string, signal: AbortSignal): Promise<ArchiveEntry[]>;
  read(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
}, signal: AbortSignal): Promise<{ bytes: Uint8Array; name: string }> {
  DownloadPathSchema.parse(root);
  const prefix = safeDownloadFilename(root);
  const files: Zippable = Object.create(null) as Zippable;
  files[`${prefix}/`] = new Uint8Array();
  const directories = [root];
  const seen = new Set<string>(); // capped by MAX_ENTRIES; discarded after this operation
  let bytes = 0;
  while (directories.length) {
    signal.throwIfAborted();
    const directory = directories.pop()!;
    const entries = await abortable(transport.list(directory, signal), signal);
    if (entries.length > MAX_ENTRIES - seen.size) throw new Error("ArchiveEntryLimit");
    for (const entry of entries) {
      signal.throwIfAborted();
      DownloadPathSchema.parse(entry.path);
      if (!entry.path.startsWith(`${root}/`) || entry.path.split("/").slice(0, -1).join("/") !== directory
        || seen.has(entry.path) || entry.path.split("/").length - root.split("/").length > 32) throw new Error("InvalidArchiveEntry");
      seen.add(entry.path);
      const name = `${prefix}/${entry.path.slice(root.length + 1)}`;
      if (entry.kind === "directory") {
        files[`${name}/`] = new Uint8Array();
        directories.push(entry.path);
      } else if (entry.kind === "file") {
        const content = await abortable(transport.read(entry.path, MAX_BYTES - bytes, signal), signal);
        signal.throwIfAborted();
        bytes += content.byteLength;
        if (bytes > MAX_BYTES) throw new Error("ArchiveByteLimit");
        files[name] = [content, { level: 0 }];
      } else throw new Error("InvalidArchiveEntry");
    }
  }
  signal.throwIfAborted();
  // Store rather than compress: bounded copies, no long compression task on the UI thread.
  return { bytes: zipSync(files, { level: 0 }), name: `${prefix}.zip` };
}
