import { constants } from "node:fs";
import { link, lstat, open, unlink, rename } from "node:fs/promises";
import type { Dir } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pinDirectory, type PinnedDirectory } from "../app-gallery/pinned-directory.js";
import { MailArchiveError, MailContentIntegrityError, type MailObject } from "./types.js";

export const MAIL_MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
export function mailObjectNamespace(ownerId: string, provider: string, connectionId: string): string {
  return createHash("sha256").update(JSON.stringify([ownerId, provider, connectionId])).digest("hex");
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function validHash(value: string): void { if (!HASH.test(value)) throw new MailArchiveError("invalid"); }

export class MailObjectStore {
  readonly root: string;
  // At most one root and one namespace iterator stay pinned between batches.
  // This provides bounded work AND progress past referenced files.
  private sweepCursor: { root: PinnedDirectory; entries: Dir; current?: PinnedDirectory; files?: Dir; namespace?: string } | null = null;
  private activeSweep: Promise<number> | null = null;
  constructor(readonly homePath: string) {
    if (!isAbsolute(homePath)) throw new MailArchiveError("invalid");
    this.root = join(resolve(homePath), "mail", "objects");
  }
  private async directory(namespace?: string): Promise<PinnedDirectory> {
    if (namespace !== undefined) validHash(namespace);
    const home = await pinDirectory(this.homePath);
    let mail: PinnedDirectory | undefined;
    let root: PinnedDirectory | undefined;
    try {
      mail = await home.ensureChild("mail");
      if (!await mail.isPrivate()) throw new MailArchiveError("integrity");
      root = await mail.ensureChild("objects");
      if (!await root.isPrivate()) throw new MailArchiveError("integrity");
      if (!namespace) { const result = root; root = undefined; return result; }
      const account = await root.ensureChild(namespace);
      if (!await account.isPrivate()) { await account.close(); throw new MailArchiveError("integrity"); }
      return account;
    } finally { await root?.close(); await mail?.close(); await home.close(); }
  }
  async put(namespace: string, bytes: Uint8Array): Promise<MailObject> {
    validHash(namespace);
    if (bytes.byteLength > MAIL_MAX_OBJECT_BYTES) throw new MailArchiveError("invalid", "Mail object exceeds body limit");
    const object = { namespace, digest: digest(bytes), sizeBytes: bytes.byteLength };
    const dir = await this.directory(namespace);
    const destination = `${dir.path}/${object.digest}`;
    const temporaryName = `.stage-${randomUUID()}`;
    const temporary = `${dir.path}/${temporaryName}`;
    try {
      const file = await dir.openFile(temporaryName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      // An exclusive hard link publishes atomically without replacing a live
      // object. The random temporary inode is removed in all outcomes.
      try { await link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info=await lstat(destination);
      if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new MailArchiveError("integrity");
      const stored=info.size>MAIL_MAX_OBJECT_BYTES?null:await dir.readFile(object.digest,MAIL_MAX_OBJECT_BYTES);
      if (!stored || stored.byteLength !== bytes.byteLength || digest(stored) !== object.digest) {
        // Replace only this pinned directory entry with the newly fsynced,
        // digest-verified inode. Never write through a corrupt/linked inode.
        await rename(temporary,destination);
        const repaired=await dir.readFile(object.digest,MAIL_MAX_OBJECT_BYTES);
        if(repaired.byteLength!==bytes.byteLength||digest(repaired)!==object.digest)throw new MailArchiveError("integrity");
      }
      const parent = await open(dir.path, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
      return object;
    } finally {
      try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } finally { await dir.close(); }
    }
  }
  async read(object: MailObject): Promise<Buffer> {
    validHash(object.namespace); validHash(object.digest);
    if (!Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0 || object.sizeBytes > MAIL_MAX_OBJECT_BYTES) throw new MailArchiveError("invalid");
    const dir = await this.directory(object.namespace);
    try {
      const info=await lstat(`${dir.path}/${object.digest}`);
      if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new MailArchiveError("integrity");
      if(info.size!==object.sizeBytes)throw new MailContentIntegrityError();
      const bytes = await dir.readFile(object.digest, MAIL_MAX_OBJECT_BYTES);
      if (bytes.length !== object.sizeBytes || digest(bytes) !== object.digest) throw new MailContentIntegrityError();
      return bytes;
    } finally { await dir.close(); }
  }
  sweep(options: {
    olderThan: Date; maxCount: number;
    // Caller holds the DB object advisory lock until remove completes.
    reclaim: (namespace: string, digest: string, remove: () => Promise<void>) => Promise<boolean>;
  }): Promise<number> {
    if (this.activeSweep) return this.activeSweep;
    this.activeSweep = this.sweepBatch(options).finally(() => { this.activeSweep = null; });
    return this.activeSweep;
  }
  private async clearSweepCursor(): Promise<void> {
    const cursor = this.sweepCursor; this.sweepCursor = null;
    if (!cursor) return;
    try { await cursor.files?.close(); }
    finally {
      try { await cursor.current?.close(); }
      finally { try { await cursor.entries.close(); } finally { await cursor.root.close(); } }
    }
  }
  private async sweepBatch(options: {
    olderThan: Date; maxCount: number;
    reclaim: (namespace: string, digest: string, remove: () => Promise<void>) => Promise<boolean>;
  }): Promise<number> {
    if (!Number.isSafeInteger(options.maxCount) || options.maxCount < 1 || !Number.isFinite(options.olderThan.getTime())) throw new MailArchiveError("invalid");
    const limit = Math.min(500, options.maxCount);
    let removed = 0;
    try {
      if (!this.sweepCursor) {
        const root = await this.directory();
        try { this.sweepCursor = { root, entries: await root.entries() }; }
        catch(error) { await root.close(); throw error; }
      }
      const cursor = this.sweepCursor;
      for (let examined=0;examined<limit;examined++) {
        if (!cursor.files) {
          const entry = await cursor.entries.read();
          if (!entry) { await this.clearSweepCursor(); break; }
          if (!HASH.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
          const dir = await cursor.root.child(entry.name);
          if (!await dir.isPrivate()) { await dir.close(); continue; }
          try { cursor.files=await dir.entries(); cursor.current=dir; cursor.namespace=entry.name; }
          catch(error) { await dir.close(); throw error; }
          continue;
        }
        const child = await cursor.files.read();
        if (!child) {
          await cursor.files.close(); await cursor.current!.close();
          cursor.files=undefined; cursor.current=undefined; cursor.namespace=undefined;
          continue;
        }
        const name=child.name;
        const staged=/^\.stage-[a-f0-9-]{36}$/.test(name);
        if ((!HASH.test(name) && !staged) || child.isSymbolicLink() || !child.isFile()) continue;
        const path=`${cursor.current!.path}/${name}`;
        const stats=await lstat(path);
        if (stats.isSymbolicLink() || !stats.isFile() || stats.mtimeMs>=options.olderThan.getTime()) continue;
        if (staged) { await unlink(path); removed++; continue; }
        if (await options.reclaim(cursor.namespace!,name,async()=>{ await unlink(path); })) removed++;
      }
      return removed;
    } catch(error) { await this.clearSweepCursor(); throw error; }
  }
  startSweep(options: Parameters<MailObjectStore["sweep"]>[0] & {
    intervalMs?: number; onError: (error: unknown) => void;
  }): () => Promise<void> {
    const timer = setInterval(() => {
      void this.sweep({ ...options, olderThan: new Date(Date.now() - 60 * 60_000) }).catch(options.onError);
    }, Math.max(60_000, options.intervalMs ?? 60 * 60_000));
    timer.unref();
    return async () => { clearInterval(timer); await this.destroy(); };
  }
  async destroy(): Promise<void> {
    try { await this.activeSweep; } finally { await this.clearSweepCursor(); }
  }
}
