import { createHash, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const MAX_PACKAGES = 512;
const MAX_TARBALL = 32 * 1024 * 1024;
const MAX_DEPENDENCIES_BYTES = 256 * 1024 * 1024;
const NAME_VERSION = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)$/;
const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/;
export interface RegistryDependency { url: string; integrity: string; filename: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function dependencyPlan(text: string): { lockfile: string; dependencies: RegistryDependency[] } {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Invalid lockfile');
  const lock: unknown = parse(text, { maxAliasCount: 0 });
  if (!object(lock) || String(lock.lockfileVersion) !== '9.0' || !object(lock.importers)
    || Object.keys(lock.importers).length !== 1 || !object(lock.importers['.']) || !object(lock.packages)
    || Object.keys(lock.packages).length > MAX_PACKAGES) throw new Error('Unsupported lockfile');
  // Reject workspace/file/git resolutions before any host network operation.
  for (const group of Object.values(lock.importers['.'])) {
    if (!object(group)) continue;
    for (const dep of Object.values(group)) if (!object(dep) || typeof dep.version !== 'string'
      || /^(?:file:|link:|workspace:|https?:|git)/.test(dep.version)) throw new Error('Unsupported dependency');
  }
  const dependencies: RegistryDependency[] = [];
  for (const [key, pkg] of Object.entries(lock.packages)) {
    const match = NAME_VERSION.exec(key);
    if (!match || !object(pkg) || !object(pkg.resolution) || Object.keys(pkg.resolution).some(k => k !== 'integrity')
      || typeof pkg.resolution.integrity !== 'string' || !INTEGRITY.test(pkg.resolution.integrity)) throw new Error('Unsupported dependency');
    const [,name,version] = match;
    const filename = `${createHash('sha256').update(pkg.resolution.integrity).digest('hex')}.tgz`;
    dependencies.push({ url: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity: pkg.resolution.integrity, filename });
    pkg.resolution = { ...pkg.resolution, tarball: `file:/deps/${filename}` };
  }
  return { lockfile: stringify(lock), dependencies };
}
export function verifyDependencyBytes(dependency: RegistryDependency, bytes: Buffer): boolean {
  const match = INTEGRITY.exec(dependency.integrity);
  if (!match || bytes.length > MAX_TARBALL) return false;
  const expected = Buffer.from(match[1], 'base64');
  const actual = createHash('sha512').update(bytes).digest();
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export async function readBoundedResponse(response: Response, maximum: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error('Object too large');
  if (!response.body) throw new Error('Missing object');
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > maximum) throw new Error('Object too large');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
/** Only trusted registry URLs derived above cross the network. Submitted code never runs here. */
export async function fetchDependencies(plan: ReturnType<typeof dependencyPlan>, directory: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  let bytes = 0;
  for (const dependency of plan.dependencies) {
    signal.throwIfAborted();
    const response = await fetcher(dependency.url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw new Error('Dependency unavailable');
    const content = await readBoundedResponse(response, Math.min(MAX_TARBALL, MAX_DEPENDENCIES_BYTES - bytes));
    if (!verifyDependencyBytes(dependency, content)) throw new Error('Dependency integrity failed');
    bytes += content.length;
    await writeFile(join(directory, dependency.filename), content, { flag: 'wx', mode: 0o600 });
  }
}
