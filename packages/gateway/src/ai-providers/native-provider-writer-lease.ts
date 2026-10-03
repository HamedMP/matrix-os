import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProviderSettingsStoreError } from './provider-settings-errors.js';
const unavailable = () => new ProviderSettingsStoreError('lifecycle_unavailable', 503);
export function createNativeProviderWriterLease(homePath: string) {
  const home = resolve(homePath);
  const directory = join(dirname(home), '.matrix-private', basename(home), 'native-writers');
  const path = (profile: 'codex' | 'claude') => join(directory, `${profile}.json`);
  return {
    async assertAvailable(profile: 'codex' | 'claude') {
      try { await lstat(path(profile)); }
      catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw unavailable();
      }
      // Gateway death/receipt expiry never proves a native child stopped.
      throw unavailable();
    },
    async acquire(profile: 'codex' | 'claude'): Promise<() => Promise<void>> {
      let parent = await realpath(dirname(home));
      for (const name of ['.matrix-private', basename(home), 'native-writers']) {
        parent = join(parent, name);
        try { await mkdir(parent, { mode: 0o700 }); }
        catch (error) {
          if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
        }
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      }
      const marker = path(profile);
      let file;
      try { file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { console.warn('[provider-settings] Native writer admission unavailable:', error instanceof Error ? error.name : 'UnknownError'); throw unavailable(); }
      let identity!: { dev: number; ino: number };
      try { identity = await file.stat(); await file.writeFile(JSON.stringify({ version: 1, profile, admissionId: randomUUID(), gatewayPid: process.pid })); await file.sync(); }
      finally { await file.close(); }
      let released = false;
      let releasing: Promise<void> | undefined;
      return () => {
        if (released) return Promise.resolve();
        // Every observer of this admission shares one identity check/unlink.
        // A failed drain remains fenced, but may be retried after it settles.
        releasing ??= (async () => {
          const current = await lstat(marker);
          if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw unavailable();
          await unlink(marker); released = true;
        })().finally(() => { releasing = undefined; });
        return releasing;
      };
    },
  };
}
