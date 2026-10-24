import { createHash } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileInput, route } from './fixtures.js';
import { profileReviewSubjectDigest, providerEvidenceBundleDigest } from '../../../packages/gateway/src/google-data/operator-review.js';
const { mockPool } = vi.hoisted(() => ({ mockPool: vi.fn(function (_config: unknown) { throw new Error('Database creation not expected'); }) }));
vi.mock('pg', () => ({ default: { Pool: mockPool } }));
import { parseGoogleDataReviewArgs, pinnedGoogleReviewDatabase, runGoogleDataReviewCli } from '../../../scripts/google-data-review-profile.js';
const sha = 'a'.repeat(64);
const base = ['--evidence-dir', '/private/review', '--profile', 'profile.json', '--manifest', 'manifest.json', '--expected-manifest-sha256', sha, '--expected-revision', '0'];
describe('Google profile operator CLI boundaries', () => {
  it('defaults to dry-run and requires an explicit flag to write', () => {
    expect(parseGoogleDataReviewArgs(base)).toMatchObject({ apply: false, expectedRevision: 0 });
    expect(() => parseGoogleDataReviewArgs([...base, '--apply'])).toThrow('Google processing review unavailable');
    expect(parseGoogleDataReviewArgs([...base, '--apply', '--database-host', 'pilot.example.test', '--database-name', 'pilot', '--receipt', 'receipt.json'])).toMatchObject({ apply: true });
  });
  it('rejects duplicate, unknown, missing, traversal and invalid revision options', () => {
    for (const args of [[...base, '--unknown'], [...base, '--expected-revision', '1'], base.slice(0, -1),
      base.map(value => value === 'profile.json' ? '../profile.json' : value), base.map(value => value === '0' ? '-1' : value)]) {
      expect(() => parseGoogleDataReviewArgs(args)).toThrow('Google processing review unavailable');
    }
  });
  it('accepts only the explicit review URL with exact host and database pins', () => {
    const options = parseGoogleDataReviewArgs([...base, '--apply', '--database-host', 'pilot.example.test', '--database-name', 'pilot', '--receipt', 'receipt.json']);
    expect(() => pinnedGoogleReviewDatabase(options, { DATABASE_URL: 'postgresql://u:p@production.example.test/prod' })).toThrow('Google processing review unavailable');
    expect(() => pinnedGoogleReviewDatabase(options, { MATRIX_GOOGLE_REVIEW_DATABASE_URL: 'postgresql://u:p@other.example.test/pilot' })).toThrow('Google processing review unavailable');
    expect(() => pinnedGoogleReviewDatabase(options, { MATRIX_GOOGLE_REVIEW_DATABASE_URL: 'postgresql://u:p@pilot.example.test/other' })).toThrow('Google processing review unavailable');
    expect(pinnedGoogleReviewDatabase(options, { MATRIX_GOOGLE_REVIEW_DATABASE_URL: 'postgresql://u:p@pilot.example.test/pilot?sslmode=require' })).toBe('postgresql://u:p@pilot.example.test/pilot?sslmode=require');
    expect(() => pinnedGoogleReviewDatabase(options, { MATRIX_GOOGLE_REVIEW_DATABASE_URL: 'postgresql://u:p@pilot.example.test/pilot?host=production.example.test' })).toThrow('Google processing review unavailable');
  });
});

const roots: string[] = [];
afterEach(async () => { mockPool.mockClear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function evidenceFixture() {
  const folder = await mkdtemp(join(tmpdir(), 'google-review-cli-')); roots.push(folder); await chmod(folder, 0o700);
  const root = await realpath(folder);
  const profile = profileInput();
  const at = Date.now();
  profile.evidence.reviewedAt = new Date(at - 1000).toISOString();
  profile.evidence.expiresAt = new Date(at + 86400_000).toISOString();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const artifacts = ['terms', 'account-settings', 'route-probe', 'data-handling', 'deletion'].map(kind => ({ kind, path: `${kind}.json`, sha256: hash(JSON.stringify({ kind })) }));
  profile.evidence.referenceDigest = providerEvidenceBundleDigest(artifacts);
  const manifest = { providerEvidenceDigest: profile.evidence.referenceDigest, version: 1, decision: 'approved', profileId: null, expectedRevision: 0,
    ownerId: profile.ownerId, reviewerId: profile.evidence.reviewerId, reviewedAt: profile.evidence.reviewedAt,
    expiresAt: profile.evidence.expiresAt, subjectDigest: profileReviewSubjectDigest(profile), observedRoutes: [route()], artifacts };
  const raw = JSON.stringify(manifest);
  for (const artifact of artifacts) await writeFile(join(root, artifact.path), JSON.stringify({ kind: artifact.kind }), { mode: 0o600 });
  await writeFile(join(root, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
  await writeFile(join(root, 'manifest.json'), raw, { mode: 0o600 });
  return ['--evidence-dir', root, '--profile', 'profile.json', '--manifest', 'manifest.json', '--expected-manifest-sha256', hash(raw), '--expected-revision', '0'];
}
describe('operator CLI execution', () => {
  it('validates the real private evidence folder without constructing a database pool in dry-run', async () => {
    const args = await evidenceFixture();
    await expect(runGoogleDataReviewCli(args, { DATABASE_URL: 'never-used' })).resolves.toMatchObject({ mode: 'dry-run', artifactCount: 5 });
    expect(mockPool).not.toHaveBeenCalled();
  });
  it('passes an explicit port in the connection URL so pg cannot fall back to ambient PGPORT', async () => {
    const args = await evidenceFixture();
    await expect(runGoogleDataReviewCli([...args, '--apply', '--database-host', 'pilot.example.test', '--database-name', 'pilot', '--receipt', 'port-receipt.json'],
      { MATRIX_GOOGLE_REVIEW_DATABASE_URL: 'postgresql://u:p@pilot.example.test/pilot?sslmode=require', PGPORT: '6432' })).rejects.toThrow('Google processing review unavailable');
    expect(mockPool).toHaveBeenCalledOnce();
    const config = mockPool.mock.calls[0]![0] as { connectionString: string };
    expect(new URL(config.connectionString).port).toBe('5432');
  });
  it('reserves an exclusive receipt before any database mutation', async () => {
    const args = await evidenceFixture(); const root = args[1]!;
    await writeFile(join(root, 'receipt.json'), 'existing evidence', { mode: 0o600 });
    await expect(runGoogleDataReviewCli([...args, '--apply', '--database-host', 'pilot.example.test', '--database-name', 'pilot', '--receipt', 'receipt.json'],
      { MATRIX_GOOGLE_REVIEW_DATABASE_URL: 'postgresql://u:p@pilot.example.test/pilot?sslmode=require' })).rejects.toThrow('Google processing review unavailable');
    expect(mockPool).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'receipt.json'), 'utf8')).toBe('existing evidence');
  });
});
