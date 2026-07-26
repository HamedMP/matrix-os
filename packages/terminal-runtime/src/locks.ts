import { spawn } from 'node:child_process';
import { type FileHandle } from 'node:fs/promises';
import { RuntimeIdSchema } from './contracts.js';
import { SecureDirectory } from './storage.js';
const LOCK_TIMEOUT_MS = 10_000;
type LockHandle = { release(): Promise<void> };
async function waitForFlock(
  handle: FileHandle,
  flockPath: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(flockPath, ['--exclusive', '3'], {
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('lock_timeout'));
    }, timeoutMs);
    timer.unref();
    child.once('error', (error: Error) => {
      finish(new Error('lock_failed', { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) finish();
      else finish(new Error('lock_failed'));
    });
  });
}
export class FlockManager {
  private constructor(
    private readonly directory: SecureDirectory,
    private readonly flockPath: string,
    private readonly timeoutMs: number,
  ) {}
  static async open(
    root: string,
    options: { flockPath?: string; timeoutMs?: number } = {},
  ): Promise<FlockManager> {
    const directory = await SecureDirectory.open(root);
    return new FlockManager(
      directory,
      options.flockPath ?? '/usr/bin/flock',
      options.timeoutMs ?? LOCK_TIMEOUT_MS,
    );
  }
  private async acquire(name: string): Promise<LockHandle> {
    const handle = await this.directory.openLock(name);
    try {
      await waitForFlock(handle, this.flockPath, this.timeoutMs);
      return { release: async () => handle.close() };
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  }
  async withNameIndex<T>(callback: () => Promise<T>): Promise<T> {
    const lock = await this.acquire('name-index.lock');
    try {
      return await callback();
    } finally {
      await lock.release();
    }
  }
  async withRuntime<T>(
    runtimeId: string,
    includeNameIndex: boolean,
    callback: () => Promise<T>,
  ): Promise<T> {
    const id = RuntimeIdSchema.parse(runtimeId);
    const held: LockHandle[] = [];
    try {
      if (includeNameIndex) held.push(await this.acquire('name-index.lock'));
      held.push(await this.acquire(`runtime-${id}.lock`));
      return await callback();
    } finally {
      for (const lock of held.reverse()) await lock.release();
    }
  }
  async close(): Promise<void> {
    await this.directory.close();
  }
}
