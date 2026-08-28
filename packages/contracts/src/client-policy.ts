import { z } from 'zod/v4';

// Deliberately bounded SemVer, shared by platform, Electron and React Native.
export const ClientVersionSchema = z.string().max(64).regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  .refine((value) => !value.split('+')[0]!.split('-').slice(1).join('-').split('.').some((part) => /^0\d+$/.test(part)));
export const ClientTargetSchema = z.enum(['desktop-macos', 'desktop-windows', 'desktop-linux', 'mobile-ios', 'mobile-android']);
export type ClientTarget = z.infer<typeof ClientTargetSchema>;

export function compareClientVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = ClientVersionSchema.parse(value).split('+')[0]!.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/)!;
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return Math.sign(left.core[i]! - right.core[i]!);
  }
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return x.length === y.length ? (x < y ? -1 : 1) : Math.sign(x.length - y.length);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const ClientDownloadUrlSchema = z.url().max(2048).refine((value) => {
  let url: URL;
  try { url = new URL(value); }
  catch (err: unknown) { if (err instanceof TypeError) return false; throw err; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (['matrix-os.com', 'app.matrix-os.com', 'apps.apple.com', 'play.google.com'].includes(url.hostname)
      || (url.hostname === 'github.com' && url.pathname.startsWith('/HamedMP/matrix-os/releases/')));
});
export const ClientPolicySchema = z.object({
  latestVersion: ClientVersionSchema,
  minSupportedVersion: ClientVersionSchema,
  downloadUrl: ClientDownloadUrlSchema,
  enforceAfter: z.iso.datetime(),
}).strict().refine((policy) => !ClientVersionSchema.safeParse(policy.minSupportedVersion).success
  || !ClientVersionSchema.safeParse(policy.latestVersion).success
  || compareClientVersions(policy.minSupportedVersion, policy.latestVersion) <= 0, {
  message: 'Minimum version exceeds latest version',
});
export type ClientPolicy = z.infer<typeof ClientPolicySchema>;
export const ClientPolicyResponseSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  policy: ClientPolicySchema.nullable(),
}).strict();
export type ClientPolicyResponse = z.infer<typeof ClientPolicyResponseSchema>;
export type ClientCompatibility = 'unknown' | 'current' | 'recommended' | 'required';
export function evaluateClientPolicy(policy: ClientPolicy | null, version: string, now = Date.now()): ClientCompatibility {
  if (!policy || !ClientVersionSchema.safeParse(version).success) return 'unknown';
  if (compareClientVersions(version, policy.minSupportedVersion) < 0 && now >= Date.parse(policy.enforceAfter)) return 'required';
  return compareClientVersions(version, policy.latestVersion) < 0 ? 'recommended' : 'current';
}
