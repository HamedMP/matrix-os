import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ draft: null as any, writes: [] as any[], preparedError: false, prepared: new Map<string, Buffer>(), original: new Map<string, Buffer>(), beforeRead: undefined as undefined | (()=>Promise<void>) }));
vi.mock('../../../packages/gateway/src/app-store/draft-store.js', () => ({ createDraftStore: () => ({
  list: async () => Array.from({length:5},()=>state.draft),
  read: async (id:string) => { await state.beforeRead?.(); return {...structuredClone(state.draft),id}; },
  write: async (draft: unknown) => { state.draft = structuredClone(draft); state.writes.push(structuredClone(draft)); },
  files: async (_: string, which: string) => new Map(which === 'original' ? state.original : state.prepared),
  writeFiles: async (_: string, which: string, files: Map<string, Buffer>) => { if (which === 'prepared') {if(state.preparedError)throw new Error('disk unavailable');state.prepared = new Map(files);} },
}) }));
vi.mock('../../../packages/gateway/src/app-store/submission-poller.js',()=>({rememberSubmissionObservation:vi.fn(async()=>{})}));
import { createStorePublishService } from '../../../packages/gateway/src/app-store/publish-service.js';
import {rememberSubmissionObservation} from '../../../packages/gateway/src/app-store/submission-poller.js';
const id = '6f84f223-bd35-4e4d-ad4a-2fb7bd9174fa';
const manifest = { name: 'Garden', slug: 'garden', description: 'A sample garden', version: '1.0.0', runtime: 'vite', permissions: [] };
let service: ReturnType<typeof createStorePublishService>;
afterEach(async () => { await service?.close(); });
function fixture() {
  state.beforeRead=undefined;state.writes=[];state.preparedError=false;
  state.original = new Map([['matrix.json', Buffer.from(JSON.stringify(manifest))], ['package.json', Buffer.from('{}')], ['pnpm-lock.yaml', Buffer.from('lockfileVersion: 9.0')], ['index.html', Buffer.from('sample')]]);
  state.prepared = new Map(state.original);
  state.draft = { id, sourceSlug: 'garden', sourceName: 'Garden', status: 'ready', stage: 'verify', ai: 'completed', blockingFindings: 0,
    createdAt: '2026-10-18T12:00:00Z', updatedAt: '2026-10-18T12:00:00Z', expiresAt: '2026-10-25T12:00:00Z',
    findingsBefore: { blocking: false, truncated: false, findings: [] }, findingsAfter: { blocking: false, truncated: false, findings: [] }, report: { ai: 'completed', changes: [] }, capabilities: { integrations: { required: [], optional: [] }, permissions: [], tables: [] }, changedFiles: [],
    listing: { slug: 'garden', name: 'Garden', tagline: 'A garden', description: 'An example app', category: 'utilities', version: '1.0.0', changelog: '' } };
  const platform = { createSubmission: vi.fn(async () => ({ versionId: id, status: 'in_review' })), finalize: vi.fn(), transfer: vi.fn() };
  const builder = { build: vi.fn(async () => new Map()), close: vi.fn(async () => {}) };
  const generalizer={status:vi.fn(),generalize:vi.fn()};
  service = createStorePublishService({ homePath: '/test', platform: platform as any, builder, generalizer:generalizer as any });
  return { platform, builder, generalizer };
}
describe('private publishing reconciliation', () => {
  it('admits at most five private drafts',async()=>{
    fixture();await expect(service.create({app:'garden'})).rejects.toMatchObject({code:'limit'});
  });
  it('reserves a draft before reading for revision so another revision or submit cannot race it',async()=>{
    fixture();let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});state.beforeRead=()=>blocked;
    const first=service.revise(id,{instructions:'Use neutral examples'});
    try{
      await expect(service.revise(id,{instructions:'Use other examples'})).rejects.toMatchObject({code:'conflict'});
      await expect(service.submit(id,{consent:true,license:'MIT'})).rejects.toMatchObject({code:'conflict'});
    }finally{release();await first;}
  });
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
    expect(rememberSubmissionObservation).toHaveBeenCalledWith('/test',id);
    expect(platform.finalize).not.toHaveBeenCalled(); expect(platform.transfer).not.toHaveBeenCalled();
    expect(state.draft.submission).toMatchObject({ status: 'in_review', versionId: id });
  });
});

it('keeps an edited draft recoverable when prepared bytes cannot be written',async()=>{fixture();state.preparedError=true;await expect(service.listing(id,{version:'1.1.0'})).rejects.toThrow();expect(state.draft).toMatchObject({status:'needs_attention',failureCode:'verify_failed'});});
it('rejects revision admission before persisting preparing when two jobs are active',async()=>{
 const {generalizer}=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});generalizer.generalize.mockImplementation(async()=>{await gate;return null;});
 try{await service.revise('11111111-1111-4111-8111-111111111111',{instructions:'Neutral examples',aiConsent:{accessSourceId:'owner_anthropic_key'}});await service.revise('22222222-2222-4222-8222-222222222222',{instructions:'Neutral examples',aiConsent:{accessSourceId:'owner_anthropic_key'}});
 await expect(service.revise('33333333-3333-4333-8333-333333333333',{instructions:'Neutral examples'})).rejects.toMatchObject({code:'limit'});expect(state.writes.some(d=>d.id==='33333333-3333-4333-8333-333333333333')).toBe(false);
 }finally{release();}
});

it('serializes concurrent revision admission across different drafts',async()=>{const {generalizer}=fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});generalizer.generalize.mockImplementation(async()=>{await gate;return null;});const input={instructions:'Neutral source',aiConsent:{accessSourceId:'owner_anthropic_key'}};try{await service.revise('11111111-1111-4111-8111-111111111111',input);const results=await Promise.allSettled([service.revise('22222222-2222-4222-8222-222222222222',input),service.revise('33333333-3333-4333-8333-333333333333',input)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(state.writes.filter(d=>d.status==='preparing')).toHaveLength(2);}finally{release();}});
