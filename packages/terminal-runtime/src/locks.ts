import { spawn } from 'node:child_process';
import { type FileHandle } from 'node:fs/promises';
import { RuntimeIdSchema } from './contracts.js';
import { SecureDirectory } from './storage.js';
const LOCK_TIMEOUT_MS = 10_000;
type LockHandle = { release(): Promise<void> };
async function acquireFlock(
  handle: FileHandle,
  flockPath: string,
  timeoutMs: number,
): Promise<LockHandle> {
  const child = spawn(
    flockPath,
    ['--exclusive', '/proc/self/fd/3', '/usr/bin/tee'],
    {
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore', handle.fd],
    },
  );
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('lock_failed');
  }
  const childInput = child.stdin;
  const childOutput = child.stdout;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      childOutput.removeListener('data', onData);
      if (error) reject(error);
      else resolve();
    };
    const onData = (): void => finish();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('lock_timeout'));
    }, timeoutMs);
    timer.unref();
    childOutput.once('data', onData);
    child.once('error', (error: Error) => {
      finish(new Error('lock_failed', { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (!settled || code !== 0 || signal !== null) {
        finish(new Error('lock_failed'));
      }
    });
    childInput.write('locked\n');
  });
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('lock_release_timeout'));
          }, timeoutMs);
          timer.unref();
          child.once('error', (error: Error) => {
            clearTimeout(timer);
            reject(new Error('lock_release_failed', { cause: error }));
          });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0 && signal === null) resolve();
            else reject(new Error('lock_release_failed'));
          });
          childInput.end();
        });
      } finally {
        await handle.close();
      }
    },
  };
}
async function probeFlock(
  handle: FileHandle,
  flockPath: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      flockPath,
      ['--exclusive', '--nonblock', '/proc/self/fd/3', '/usr/bin/true'],
      {
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('lock_probe_timeout'));
    }, timeoutMs);
    timer.unref();
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(new Error('lock_probe_failed', { cause: error }));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) reject(new Error('lock_probe_failed'));
      else if (code === 0) resolve(false);
      else if (code === 1) resolve(true);
      else reject(new Error('lock_probe_failed'));
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
      return await acquireFlock(handle, this.flockPath, this.timeoutMs);
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
  async isRuntimeLocked(runtimeId: string): Promise<boolean> {
    const id = RuntimeIdSchema.parse(runtimeId);
    const handle = await this.directory.openLock(`runtime-${id}.lock`);
    try {
      return await probeFlock(handle, this.flockPath, this.timeoutMs);
    } finally {
      await handle.close();
    }
  }
  async close(): Promise<void> {
    await this.directory.close();
  }
}
