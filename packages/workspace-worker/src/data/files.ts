/** Immutable R2 objects are published through an atomic Postgres revision pointer. */
export const MAX_TEXT_BYTES = 128 * 1024;
export interface WorkspaceFiles {
  read(key: string): Promise<string | null>;
  write(ownerId: string, content: string): Promise<string>;
  remove(key: string): Promise<void>;
}
export interface WorkspaceBucket {
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  list?(options: { prefix: string; limit: number; cursor?: string }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
}
export class R2WorkspaceFiles implements WorkspaceFiles {
  constructor(private readonly bucket: WorkspaceBucket) {}
  async read(key: string) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    if (object.size > MAX_TEXT_BYTES) throw new Error("File exceeds text limit");
    return object.text();
  }
  async write(ownerId: string, content: string) {
    if (new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) throw new Error("File exceeds text limit");
    const key = `workspace-files/${encodeURIComponent(ownerId)}/${crypto.randomUUID()}`;
    await this.bucket.put(key, content, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    return key;
  }
  /** Called by scheduled cleanup; cursor allows bounded continuation across runs. */
  async sweepUnreferenced(references: (keys: string[]) => Promise<string[]>, options: { now?: number; graceMs?: number; cursor?: string } = {}): Promise<{ deleted: number; cursor?: string }> {
    if (!this.bucket.list) return { deleted: 0 };
    const page = await this.bucket.list({ prefix: "workspace-files/", limit: 100, cursor: options.cursor });
    if (page.objects.length > 100) throw new Error("Cleanup page exceeds limit");
    const cutoff = (options.now ?? Date.now()) - (options.graceMs ?? 86_400_000);
    const old = page.objects.filter((object) => object.key.startsWith("workspace-files/") && object.uploaded.getTime() < cutoff);
    const live = await references(old.map((object) => object.key));
    if (live.length > 100) throw new Error("Cleanup reference limit exceeded");
    let deleted = 0;
    for (const object of old) {
      if (live.includes(object.key)) continue;
      await this.bucket.delete(object.key); deleted++;
    }
    return { deleted, ...(page.truncated ? { cursor: page.cursor } : {}) };
  }
  async remove(key: string) { await this.bucket.delete(key); }
}
