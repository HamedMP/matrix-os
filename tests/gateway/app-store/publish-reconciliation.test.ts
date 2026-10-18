import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ draft: null as any, prepared: new Map<string, Buffer>(), original: new Map<string, Buffer>() }));
vi.mock('../../../packages/gateway/src/app-store/draft-store.js', () => ({ createDraftStore: () => ({
  read: async () => structuredClone(state.draft),
  write: async (draft: unknown) => { state.draft = structuredClone(draft); },
  files: async (_: string, which: string) => new Map(which === 'original' ? state.original : state.prepared),
  writeFiles: async (_: string, which: string, files: Map<string, Buffer>) => { if (which === 'prepared') state.prepared = new Map(files); },
}) }));
vi.mock('../../../packages/gateway/src/owner-file-mutations.js', () => ({ withOwnerFileMutation: async (_: string, action: () => unknown) => action() }));
import { createStorePublishService } from '../../../packages/gateway/src/app-store/publish-service.js';
const id = '6f84f223-bd35-4e4d-ad4a-2fb7bd9174fa';
const manifest = { name: 'Garden', slug: 'garden', description: 'A sample garden', version: '1.0.0', runtime: 'vite', permissions: [] };
let service: ReturnType<typeof createStorePublishService>;
afterEach(async () => { await service?.close(); });
function fixture() {
  state.original = new Map([['matrix.json', Buffer.from(JSON.stringify(manifest))], ['package.json', Buffer.from('{}')], ['pnpm-lock.yaml', Buffer.from('lockfileVersion: 9.0')], ['index.html', Buffer.from('sample')]]);
  state.prepared = new Map(state.original);
  state.draft = { id, sourceSlug: 'garden', sourceName: 'Garden', status: 'ready', stage: 'verify', ai: 'completed', blockingFindings: 0,
    createdAt: '2026-10-18T12:00:00Z', updatedAt: '2026-10-18T12:00:00Z', expiresAt: '2026-10-25T12:00:00Z',
    findingsBefore: { blocking: false, truncated: false, findings: [] }, findingsAfter: { blocking: false, truncated: false, findings: [] }, report: { ai: 'completed', changes: [] }, capabilities: { integrations: { required: [], optional: [] }, permissions: [], tables: [] }, changedFiles: [],
    listing: { slug: 'garden', name: 'Garden', tagline: 'A garden', description: 'An example app', category: 'utilities', version: '1.0.0', changelog: '' } };
  const platform = { createSubmission: vi.fn(async () => ({ versionId: id, status: 'in_review' })), finalize: vi.fn(), transfer: vi.fn() };
  const builder = { build: vi.fn(async () => new Map()), close: vi.fn(async () => {}) };
  service = createStorePublishService({ homePath: '/test', platform: platform as any, builder, generalizer: { status: vi.fn(), generalize: vi.fn() } as any });
  return { platform, builder };
}
describe('private publishing reconciliation', () => {
  it('rebuilds edited slug/version in the private source before allowing submission', async () => {
    const { builder } = fixture();
    const result = await service.listing(id, { slug: 'shared-garden', version: '1.1.0' });
    expect(result.status).toBe('preparing');
    await service.close();
    expect(JSON.parse(state.prepared.get('matrix.json')!.toString())).toMatchObject({ slug: 'shared-garden', version: '1.1.0' });
    expect(JSON.parse(state.original.get('matrix.json')!.toString())).toMatchObject({ slug: 'garden', version: '1.0.0' });
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(state.draft.status).toBe('ready');
    expect(state.draft.changedFiles).toContainEqual({ path: 'matrix.json', change: 'modified' });
  });
  it('keeps an edited source unavailable when local verification fails', async () => {
    const { builder } = fixture(); builder.build.mockRejectedValueOnce(new Error('unavailable'));
    await service.listing(id, { version: '1.1.0' }); await service.close();
    expect(state.draft).toMatchObject({ status: 'needs_attention', failureCode: 'build_failed' });
  });
  it('reconciles a previously finalized submission after a lost response', async () => {
    const { platform } = fixture();
    const result = await service.submit(id, { consent: true, license: 'MIT' });
    expect(result.status).toBe('submitted');
    expect(platform.finalize).not.toHaveBeenCalled(); expect(platform.transfer).not.toHaveBeenCalled();
    expect(state.draft.submission).toMatchObject({ status: 'in_review', versionId: id });
  });
});
