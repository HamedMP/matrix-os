import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProviderSettingsStoreError } from './provider-settings-errors.js';
const unavailable = () => new ProviderSettingsStoreError('lifecycle_unavailable', 503);
export type NativeWriterProfile = 'codex' | 'claude' | 'pi' | 'opencode' | 'hermes' | 'openclaw';
const profiles: readonly NativeWriterProfile[] = ['codex', 'claude', 'pi', 'opencode', 'hermes', 'openclaw'];
export function createNativeProviderWriterLease(homePath: string) {
  const home = resolve(homePath);
  async function trustedParent() {
    const uid = process.getuid?.();
    if (uid === undefined) throw unavailable();
    let canonicalHome: string;
    try { canonicalHome = await realpath(home); }
    catch (error) { console.warn('[provider-settings] Owner home unavailable:', error instanceof Error ? error.name : 'UnknownError'); throw unavailable(); }
    const parent = dirname(canonicalHome);
    // Check lexical ancestors too: resolving an alias must not hide a shared,
    // replaceable directory above it. Root/current-UID symlinks are trusted.
    for (const start of [home, canonicalHome]) {
      for (let ancestor = start; ; ancestor = dirname(ancestor)) {
        let info;
        try { info = await lstat(ancestor); }
        catch (error) { console.warn('[provider-settings] Owner ancestor unavailable:', error instanceof Error ? error.name : 'UnknownError'); throw unavailable(); }
        const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
        if ((!info.isDirectory() && !info.isSymbolicLink()) || ![0, uid].includes(info.uid)
          || !info.isSymbolicLink() && (info.mode & 0o022) !== 0 && !stickyRoot) throw unavailable();
        if (dirname(ancestor) === ancestor) break;
      }
    }
    return { parent, canonicalHome, uid };
  }
  async function prepare(create: boolean) {
    const trusted = await trustedParent();
    let parent = trusted.parent;
    for (const name of ['.matrix-private', basename(trusted.canonicalHome), 'native-writers']) {
      parent = join(parent, name);
      if (create) {
        try { await mkdir(parent, { mode: 0o700 }); }
        catch (error) {
          if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
        }
      }
      let info;
      try { info = await lstat(parent); }
      catch (error) {
        if (!create && error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return { uid: trusted.uid, directory: join(trusted.parent, '.matrix-private', basename(trusted.canonicalHome), 'native-writers') };
        throw unavailable();
      }
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== trusted.uid
        || (info.mode & 0o777) !== 0o700) throw unavailable();
    }
    return { uid: trusted.uid, directory: join(trusted.parent, '.matrix-private', basename(trusted.canonicalHome), 'native-writers') };
  }
  return {
    async assertAvailable(profile: NativeWriterProfile) {
      if (!profiles.includes(profile)) throw unavailable();
      const { directory } = await prepare(false);
      try { await lstat(join(directory, `${profile}.json`)); }
      catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw unavailable();
      }
      // Gateway death/receipt expiry never proves a native child stopped.
      throw unavailable();
    },
    async acquire(profile: NativeWriterProfile): Promise<() => Promise<void>> {
      if (!profiles.includes(profile)) throw unavailable();
      const { uid, directory } = await prepare(true);
      const marker = join(directory, `${profile}.json`);
      let file;
      try { file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { console.warn('[provider-settings] Native writer admission unavailable:', error instanceof Error ? error.name : 'UnknownError'); throw unavailable(); }
      let identity: { dev: number; ino: number } | undefined;
      try {
        identity = await file.stat();
        await file.writeFile(JSON.stringify({ version: 1, profile, admissionId: randomUUID(), gatewayPid: process.pid }));
        await file.sync(); await file.close();
      } catch (error) {
        // No caller has received admission yet, so no native writer can exist.
        try { await file.close(); }
        catch (closeError) { console.warn('[provider-settings] Admission descriptor close failed:', closeError instanceof Error ? closeError.name : 'UnknownError'); }
        try {
          const checked = await prepare(false);
          if (checked.directory !== directory) throw unavailable();
          const current = await lstat(marker);
          if (!current.isFile() || current.isSymbolicLink() || current.uid !== uid
            || identity && (current.dev !== identity.dev || current.ino !== identity.ino)) throw unavailable();
          await unlink(marker);
        } catch (cleanupError) { console.warn('[provider-settings] Unadmitted marker cleanup failed:', cleanupError instanceof Error ? cleanupError.name : 'UnknownError'); }
        throw error;
      }
      const admittedIdentity = identity;
      let released = false;
      let releasing: Promise<void> | undefined;
      return () => {
        if (released) return Promise.resolve();
        // Every observer of this admission shares one identity check/unlink.
        // A failed drain remains fenced, but may be retried after it settles.
        releasing ??= (async () => {
          const checked = await prepare(false);
          if (checked.directory !== directory) throw unavailable();
          const current = await lstat(marker);
          if (!current.isFile() || current.isSymbolicLink() || current.dev !== admittedIdentity.dev || current.ino !== admittedIdentity.ino) throw unavailable();
          await unlink(marker); released = true;
        })().finally(() => { releasing = undefined; });
        return releasing;
      };
    },
  };
}
