import { z } from 'zod/v4';

export const DEVSTACK_SOURCE_DELTA_MAX_BYTES = 4 * 1024 * 1024;
const maxEntries = 1000;
const maxPathLength = 4096;
const maxPathDepth = 64;

// Keep these exclusions aligned with scripts/devstack/source-projection.mjs.
// This ingress also rejects Windows-ambiguous path spellings and symlinks.
const generatedDirectories = new Set([
  'node_modules', '.pnpm-store', '.next', '.turbo', '.vite', 'coverage', 'dist', 'playwright-report', 'test-results',
]);
const privateNames = new Set([
  '.aws', '.azure', '.direnv', '.docker', '.envrc', '.git', '.gnupg', '.kube', '.matrixos', '.netrc', '.npmrc',
  '.pypirc', '.secrets', '.ssh', '.vault-token', 'application_default_credentials.json', 'credentials.json', 'secrets.json',
]);
const protectedRoots = ['packages/platform/data', '.config/gcloud', 'output', '.worktrees'];

function validSourcePath(path: string): boolean {
  if (/[\\\p{Cc}\p{Cf}\p{Cs}\u2028\u2029:<>|?*"]/u.test(path)) return false;
  const lower = portableName(path);
  const parts = lower.split('/');
  const name = parts.at(-1)!;
  if (parts.length > maxPathDepth || parts.some(part => !part || /[ .]$/.test(part))) return false;
  if (protectedRoots.some(root => lower === root || lower.startsWith(root + '/'))) return false;
  if (parts.some(part => privateNames.has(part) || generatedDirectories.has(part)
    || part === '.env' || part.startsWith('.env.'))) return false;
  return !/\.(?:env|pem|key|p12|pfx|kdbx)$/.test(name)
    && !/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)
    && name !== 'next-env.d.ts' && name !== '.build-stamp' && !name.endsWith('.tsbuildinfo');
}

const pathSchema = z.string().min(1).max(maxPathLength);
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    path: pathSchema,
    mode: z.literal([0o644, 0o755]),
    content: z.string().max(DEVSTACK_SOURCE_DELTA_MAX_BYTES),
  }),
  z.strictObject({ kind: z.literal('delete'), path: pathSchema }),
]);
const deltaSchema = z.strictObject({
  base: z.string().length(40).regex(/^[0-9a-f]+$/),
  entries: z.array(entrySchema).max(maxEntries),
});

export type DevstackSourceDelta = z.infer<typeof deltaSchema>;

function hasValidSourcePaths(entries: DevstackSourceDelta['entries']): boolean {
  const names = new Map<string, { spelling: string; entry: boolean }>();
  for (const { path } of entries) {
    if (!validSourcePath(path)) return false;
    for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1)) {
      const parent = path.slice(0, end);
      const key = portableName(parent);
      const prior = names.get(key);
      if (prior && (prior.entry || prior.spelling !== parent)) return false;
      names.set(key, { spelling: parent, entry: false });
    }
    const key = portableName(path);
    if (names.has(key)) return false;
    names.set(key, { spelling: path, entry: true });
  }
  return true;
}

function portableName(path: string): string {
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

/** Parse a JSON body already bounded by the HTTP transport before buffering. */
export function parseDevstackSourceDelta(body: unknown): DevstackSourceDelta | null {
  const parsed = deltaSchema.safeParse(body);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > DEVSTACK_SOURCE_DELTA_MAX_BYTES) return null;
  const { entries } = parsed.data;
  if (!hasValidSourcePaths(entries)) return null;
  if (entries.some(entry => entry.kind === 'file'
    && Buffer.from(entry.content, 'base64').toString('base64') !== entry.content)) return null;
  return parsed.data;
}
