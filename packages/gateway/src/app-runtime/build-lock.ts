import { realpath } from 'node:fs/promises';
import { BuildError } from './errors.js';

const MAX_LIVE_DIRECTORIES = 128;
const MAX_CALLERS_PER_DIRECTORY = 17; // One holder plus sixteen queued callers.
interface BuildOwnership { tail: Promise<void>; callers: number }
// All orchestrators in this gateway share ownership, including install/publish instances.
// Only live holders/waiters remain in this capped registry; settled keys are removed.
const ownership = new Map<string, BuildOwnership>();
export async function withAppBuildLock<T>(appDir: string, operation: (canonicalDir: string) => Promise<T>): Promise<T> {
 let key: string;
 try { key = await realpath(appDir); }
 catch (error) {
  console.warn('[build] App directory unavailable', error instanceof Error ? error.name : 'UnknownError');
  throw new BuildError('build_failed', 'prepare', null, 'App directory unavailable');
 }
 let entry = ownership.get(key);
 if (!entry) {
  if (ownership.size >= MAX_LIVE_DIRECTORIES) throw new BuildError('build_failed', 'prepare', null, 'App build queue unavailable');
  entry = { tail: Promise.resolve(), callers: 0 }; ownership.set(key, entry);
 }
 if (entry.callers >= MAX_CALLERS_PER_DIRECTORY) throw new BuildError('build_failed', 'prepare', null, 'App build queue unavailable');
 const previous = entry.tail;
 const finished = Promise.withResolvers<void>();
 entry.tail = finished.promise; entry.callers++;
 try { await previous; return await operation(key); }
 finally {
  // Resolve only after the real callback settles; a timer must never unlock live IO.
  finished.resolve(); entry.callers--;
  if (!entry.callers) ownership.delete(key);
 }
}
