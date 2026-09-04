import type { PlatformDB } from './db.js';

/** Calendar releases order numerically; main bundles use immutable build times.
 * Unknown legacy provenance may bootstrap, but known newer installs never
 * downgrade from a passive stable pointer. Operators use an explicit bridge. */
export async function isBackendDowngrade(db: PlatformDB, target: string, installed: string | null): Promise<boolean> {
  if (!installed || target === installed) return false;
  const parse = (version: string) => /^v?(\d{4})\.(\d{2})\.(\d{2})(?:[-.](\d+))?(?:$|[^\d])/.exec(version)?.slice(1).map(n => Number(n ?? 0));
  const a = parse(target), b = parse(installed);
  if (a && b) {
    const i = a.findIndex((n, index) => n !== b[index]);
    return i >= 0 && a[i] < b[i];
  }
  const rows = await db.executor.selectFrom('host_bundle_releases').select(['version', 'build_time']).where('version', 'in', [target, installed]).execute();
  const targetTime = Date.parse(rows.find(r => r.version === target)?.build_time ?? '');
  const installedTime = Date.parse(rows.find(r => r.version === installed)?.build_time ?? '');
  return Number.isFinite(targetTime) && Number.isFinite(installedTime) && targetTime < installedTime;
}
