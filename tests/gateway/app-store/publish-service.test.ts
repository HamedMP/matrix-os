import {describe,it,expect,vi} from 'vitest';
import {preparePublishDraft} from '../../../packages/gateway/src/app-store/prepare-draft.js';
const manifest={name:'Test App',slug:'test-app',description:'A sample app',version:'1.0.0',runtime:'vite',permissions:[],storage:{tables:{}}};
const source=()=>new Map([['matrix.json',Buffer.from(JSON.stringify(manifest))],['index.html',Buffer.from('hello')],['package.json',Buffer.from('{}')],['pnpm-lock.yaml',Buffer.from('lockfileVersion: 9.0')]]);
describe('owner draft preparation',()=>{
 it('does not transmit source without provider-specific consent',async()=>{
  const generalize=vi.fn(async()=>null);const build=vi.fn();
  const result=await preparePublishDraft({files:source(),ownerTerms:[],generalizer:{generalize},builder:{build},signal:AbortSignal.timeout(1000)});
  expect(generalize).not.toHaveBeenCalled();expect(result.status).toBe('needs_attention');expect(build).not.toHaveBeenCalled();
 });
 it('does not mark ready when local isolation cannot verify the build',async()=>{
  const files=source();const generalize=vi.fn(async()=>({files,report:{ai:'completed',changes:[]},listing:{slug:'test-app',name:'Test App',tagline:'A test',description:'A test app',category:'utilities',version:'1.0.0',changelog:''}}));
  const result=await preparePublishDraft({files,ownerTerms:[],generalizer:{generalize},builder:{build:async()=>{throw new Error('unavailable');}},aiConsent:{accessSourceId:'owner_anthropic_key'},signal:AbortSignal.timeout(1000)});
  expect(result.status).toBe('needs_attention');expect(result.failureCode).toBe('build_failed');
 });
 it('scrubs credentials before any provider sees the copy',async()=>{
  const files=source();files.set('index.html',Buffer.from('sk-ant-abcdefghijklmnopqrstuvwxyz1234567890'));
  const generalize=vi.fn(async(copy:Map<string,Buffer>)=>{expect(copy.get('index.html')?.toString()).not.toContain('sk-ant-');return null;});
  await preparePublishDraft({files,ownerTerms:[],generalizer:{generalize},builder:{build:vi.fn()},aiConsent:{accessSourceId:'owner_anthropic_key'},signal:AbortSignal.timeout(1000)});
  expect(files.get('index.html')?.toString()).toContain('sk-ant-');
 });
});
