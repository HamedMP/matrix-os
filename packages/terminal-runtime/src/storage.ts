import { randomBytes } from 'node:crypto';
import {
  constants,
  type Dirent,
  type Stats,
} from 'node:fs';
import {
  type FileHandle,
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const DEFAULT_MAX_ENTRIES = 512;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const SAFE_LEAF_NAME = /^[^/\0]{1,255}$/;
function stateError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}
function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function validateFileName(name: string): string {
  if (!SAFE_FILE_NAME.test(name)) throw stateError('unsafe_file_name');
  return name;
}
function validateLeafName(name: string): string {
  if (
    !SAFE_LEAF_NAME.test(name) ||
    name === '.' ||
    name === '..'
  ) throw stateError('unsafe_file_name');
  return name;
}
async function ensureDirectoryPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current = isAbsolute(absolute) ? sep : '';
  for (const part of parts) {
    current = current === sep ? `${sep}${part}` : resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw stateError('unsafe_parent');
    } catch (error: unknown) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError: unknown) {
        if (!isErrorCode(mkdirError, 'EEXIST')) throw mkdirError;
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw stateError('unsafe_parent');
    }
  }
}
function assertSafeFileStat(stat: Stats, maxBytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw stateError('unsafe_file');
  }
  if (stat.size > maxBytes) throw stateError('state_too_large');
}
function encodeJson(value: unknown, maxBytes: number): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (encoded.byteLength > maxBytes) throw stateError('state_too_large');
  return encoded;
}
export class SecureDirectory {
  private closed = false;
  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly maxEntries: number,
    private readonly owner?: { uid: number; gid: number },
  ) {}
  static async open(
    path: string,
    options: {
      maxEntries?: number;
      owner?: { uid: number; gid: number };
    } = {},
  ): Promise<SecureDirectory> {
    await ensureDirectoryPath(path);
    const absolute = resolve(path);
    const parentStat = await lstat(absolute);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw stateError('unsafe_parent');
    }
    if ((parentStat.mode & 0o777) !== 0o700) {
      await chmod(absolute, 0o700);
    }
    if (
      options.owner &&
      (parentStat.uid !== options.owner.uid || parentStat.gid !== options.owner.gid)
    ) {
      await chown(absolute, options.owner.uid, options.owner.gid);
    }
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedStat = await handle.stat();
    if (
      !openedStat.isDirectory() ||
      openedStat.dev !== parentStat.dev ||
      openedStat.ino !== parentStat.ino
    ) {
      await handle.close();
      throw stateError('unsafe_parent');
    }
    return new SecureDirectory(
      absolute,
      handle,
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      options.owner,
    );
  }
  private procPath(name?: string): string {
    if (this.closed) throw stateError('state_closed');
    const base = `/proc/self/fd/${this.handle.fd}`;
    return name === undefined ? base : `${base}/${validateFileName(name)}`;
  }
  async openLock(name: string): Promise<FileHandle> {
    const handle = await open(
      this.procPath(name),
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw stateError('unsafe_file');
      if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      if (
        this.owner &&
        (stat.uid !== this.owner.uid || stat.gid !== this.owner.gid)
      ) {
        await handle.chown(this.owner.uid, this.owner.gid);
      }
      return handle;
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  }
  async list(): Promise<string[]> {
    const directory = await opendir(this.procPath());
    const names: string[] = [];
    try {
      let entry: Dirent | null;
      while ((entry = await directory.read()) !== null) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (names.length >= this.maxEntries) throw stateError('state_capacity');
        names.push(entry.name);
      }
    } finally {
      await directory.close();
    }
    return names.sort();
  }
  async readBytes(
    name: string,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
  ): Promise<Buffer> {
    const path = this.procPath(name);
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (error: unknown) {
      if (isErrorCode(error, 'ENOENT')) throw stateError('state_not_found', error);
      throw error;
    }
    assertSafeFileStat(before, maxBytes);
    let file: FileHandle;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (isErrorCode(error, 'ELOOP')) throw stateError('unsafe_file', error);
      throw error;
    }
    try {
      const after = await file.stat();
      assertSafeFileStat(after, maxBytes);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw stateError('unsafe_file');
      }
      const bytes = Buffer.allocUnsafe(maxBytes + 1);
      let offset = 0;
      while (offset <= maxBytes) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          maxBytes + 1 - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) throw stateError('state_too_large');
      return bytes.subarray(0, offset);
    } finally {
      await file.close();
    }
  }
  async readJson(name: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<unknown> {
    const bytes = await this.readBytes(name, maxBytes);
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) throw stateError('state_invalid', error);
      throw error;
    }
  }
  async statFile(
    name: string,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
  ): Promise<{ size: number; mtimeMs: number }> {
    const path = this.procPath(name);
    const before = await lstat(path).catch((error: unknown) => {
      if (isErrorCode(error, 'ENOENT')) throw stateError('state_not_found', error);
      throw error;
    });
    assertSafeFileStat(before, maxBytes);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((error: unknown) => {
        if (isErrorCode(error, 'ELOOP')) throw stateError('unsafe_file', error);
        throw error;
      });
    try {
      const after = await file.stat();
      assertSafeFileStat(after, maxBytes);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw stateError('unsafe_file');
      }
      return { size: after.size, mtimeMs: after.mtimeMs };
    } finally {
      await file.close();
    }
  }
  async createJsonExclusive(
    name: string,
    value: unknown,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
  ): Promise<void> {
    const targetName = validateFileName(name);
    const bytes = encodeJson(value, maxBytes);
    const tempName = `tmp-${randomBytes(12).toString('hex')}`;
    const tempPath = this.procPath(tempName);
    let temp: FileHandle | undefined;
    try {
      temp = await open(
        tempPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      if (this.owner) await temp.chown(this.owner.uid, this.owner.gid);
      await temp.writeFile(bytes);
      await temp.sync();
      await temp.close();
      temp = undefined;
      try {
        await link(tempPath, this.procPath(targetName));
      } catch (error: unknown) {
        if (isErrorCode(error, 'EEXIST')) throw stateError('state_conflict', error);
        throw error;
      }
      await unlink(tempPath);
      await this.handle.sync();
    } catch (error: unknown) {
      if (temp) await temp.close();
      await unlink(tempPath).catch((cleanupError: unknown) => {
        if (!isErrorCode(cleanupError, 'ENOENT')) throw cleanupError;
      });
      throw error;
    }
  }
  async replaceJson(
    name: string,
    value: unknown,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
  ): Promise<void> {
    const targetName = validateFileName(name);
    const bytes = encodeJson(value, maxBytes);
    const tempName = `tmp-${randomBytes(12).toString('hex')}`;
    const tempPath = this.procPath(tempName);
    let temp: FileHandle | undefined;
    try {
      temp = await open(
        tempPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      if (this.owner) await temp.chown(this.owner.uid, this.owner.gid);
      await temp.writeFile(bytes);
      await temp.sync();
      await temp.close();
      temp = undefined;
      await rename(tempPath, this.procPath(targetName));
      await this.handle.sync();
    } catch (error: unknown) {
      if (temp) await temp.close();
      await unlink(tempPath).catch((cleanupError: unknown) => {
        if (!isErrorCode(cleanupError, 'ENOENT')) throw cleanupError;
      });
      throw error;
    }
  }
  async moveExclusive(from: string, to: string): Promise<void> {
    const source = this.procPath(from);
    const target = this.procPath(to);
    const before = await lstat(source).catch((error: unknown) => {
      if (isErrorCode(error, 'ENOENT')) throw stateError('state_not_found', error);
      throw error;
    });
    assertSafeFileStat(before, DEFAULT_MAX_FILE_BYTES);
    try {
      await link(source, target);
    } catch (error: unknown) {
      if (isErrorCode(error, 'EEXIST')) throw stateError('state_conflict', error);
      throw error;
    }
    try {
      await unlink(source);
      await this.handle.sync();
    } catch (error: unknown) {
      await unlink(target).catch((cleanupError: unknown) => {
        if (!isErrorCode(cleanupError, 'ENOENT')) throw cleanupError;
      });
      throw error;
    }
  }
  async remove(name: string): Promise<void> {
    const path = this.procPath(name);
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (error: unknown) {
      if (isErrorCode(error, 'ENOENT')) throw stateError('state_not_found', error);
      throw error;
    }
    assertSafeFileStat(before, DEFAULT_MAX_FILE_BYTES);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if (isErrorCode(error, 'ELOOP')) throw stateError('unsafe_file', error);
        throw error;
      },
    );
    try {
      const after = await file.stat();
      assertSafeFileStat(after, DEFAULT_MAX_FILE_BYTES);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw stateError('unsafe_file');
      }
    } finally {
      await file.close();
    }
    await unlink(path);
    await this.handle.sync();
  }
  async removeLeaf(name: string): Promise<void> {
    const path = `${this.procPath()}/${validateLeafName(name)}`;
    const before = await lstat(path).catch((error: unknown) => {
      if (isErrorCode(error, 'ENOENT')) throw stateError('state_not_found', error);
      throw error;
    });
    if (before.isSymbolicLink()) {
      await unlink(path);
      await this.handle.sync();
      return;
    }
    assertSafeFileStat(before, Number.MAX_SAFE_INTEGER);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((error: unknown) => {
        if (isErrorCode(error, 'ELOOP')) throw stateError('unsafe_file', error);
        throw error;
      });
    try {
      const after = await file.stat();
      assertSafeFileStat(after, Number.MAX_SAFE_INTEGER);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw stateError('unsafe_file');
      }
    } finally {
      await file.close();
    }
    await unlink(path);
    await this.handle.sync();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}
export function isStateNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === 'state_not_found';
}
export function secureChildPath(parent: string, child: string): string {
  validateFileName(child);
  const target = resolve(parent, child);
  if (dirname(target) !== resolve(parent)) throw stateError('unsafe_file_name');
  return target;
}
