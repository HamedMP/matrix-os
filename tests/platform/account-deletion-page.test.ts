import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getAccountDeletionPage } from '../../packages/platform/src/account-deletion/page.js';

function fixture(status='processing', initialStatus?: Promise<unknown>, responseError?: Error) {
 const page=getAccountDeletionPage({nonce:'test',publishableKey:'pk_live_example'});
 const elements=new Map<string,any>();
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,{hidden:id==='account'||(id==='apple-revocation' && /<p id="apple-revocation"[^>]*\bhidden\b/.test(page)),disabled:false,checked:true,textContent:'',listeners:{},addEventListener(event:string,cb:()=>unknown){this.listeners[event]=cb;},replaceChildren(){},appendChild(){}});return elements.get(id);};
 const script=page.match(/<script nonce="test">([\s\S]*?)<\/script>/)![1];
 const fetch=vi.fn(async(path:string)=>({ok:!responseError,json:async()=>{if(responseError)throw responseError;return path.includes('/export')?{downloads:[],nextCursor:'next',instructions:[]}:initialStatus??({status,completesBy:new Date().toISOString(),billingStopped:true});}}));
 const warn=vi.fn();
 const Clerk={session:{getToken:async()=> 'token'},load:async()=>{}};
 runInNewContext(script,{document:{getElementById:element,createElement:()=>({click(){},remove(){}})},window:{Clerk},fetch,AbortSignal,URL,location:{origin:'https://app.matrix-os.com',assign(){}},Blob,SyntaxError,console:{...console,warn}});
 return {element,fetch,warn};
}
describe('deletion page lifecycle',()=>{
 it('shows Apple removal instructions when automatic token revocation is unavailable',async()=>{
   const {element}=fixture('scheduled',Promise.resolve({status:'scheduled',erasesAfter:'2026-10-10T12:00:00Z',billingStopped:true,manualAppleRevocationRequired:true}));
   await vi.waitFor(()=>expect(element('account').hidden).toBe(false));
   expect(element('apple-revocation').hidden).toBe(false);
   expect(getAccountDeletionPage({nonce:'test'})).toContain('https://support.apple.com/102571');
 });
 it('keeps Apple removal guidance visible after completion removes credential metadata',async()=>{
   const {element}=fixture('completed');
   await vi.waitFor(()=>expect(element('status').textContent).toBe('Your account has been deleted.'));
   expect(element('apple-revocation').hidden).toBe(false);
   const guidance=getAccountDeletionPage({nonce:'test'}).match(/<p id="apple-revocation"[^>]*>[\s\S]*?<\/p>/)![0];
   expect(guidance).toContain('https://support.apple.com/102571');
   expect(guidance).toContain('If you used Sign in with Apple');
   expect(guidance).not.toMatch(/<p[^>]*\bhidden\b/);
 });
 it('keeps conditional Apple instructions available after cancellation without claiming deletion continues',async()=>{
   const {element}=fixture('cancelled');
   await vi.waitFor(()=>expect(element('status').textContent).toBe('No account deletion is scheduled.'));
   expect(element('apple-revocation').hidden).toBe(false);
   const guidance=getAccountDeletionPage({nonce:'test'}).match(/<p id="apple-revocation"[^>]*>[\s\S]*?<\/p>/)![0];
   expect(guidance).toContain('If you used Sign in with Apple');
   expect(guidance).not.toContain('Your Matrix account deletion will continue');
 });
 it('reports malformed error responses without exposing response details',async()=>{
   const {element,warn}=fixture('none',undefined,new SyntaxError('private response body'));
   await vi.waitFor(()=>expect(element('error').textContent).toContain('could not be completed'));
   expect(element('account').hidden).toBe(true);
   expect(warn).toHaveBeenCalledWith('Unable to read account response.');
   expect(element('error').textContent).not.toContain('private response body');
 });
 it('keeps account actions hidden until the initial status is applied',async()=>{
   let resolveStatus!:(status:unknown)=>void;
   const initialStatus=new Promise(resolve=>{resolveStatus=resolve;});
   const {element,fetch}=fixture('none',initialStatus);
   await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
   expect(element('account').hidden).toBe(true);
   resolveStatus({status:'scheduled',erasesAfter:'2026-10-10T12:00:00Z',billingStopped:true});
   await vi.waitFor(()=>expect(element('account').hidden).toBe(false));
   expect(element('status').textContent).toContain('Deletion starts');
   expect(element('confirm').hidden).toBe(true);
   expect(element('cancel').hidden).toBe(false);
 });
 it('keeps account actions hidden when the initial status fails',async()=>{
   let rejectStatus!:(error:Error)=>void;
   const initialStatus=new Promise((_resolve,reject)=>{rejectStatus=reject;});
   const {element,fetch}=fixture('none',initialStatus);
   await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
   rejectStatus(new Error('unavailable'));
   await vi.waitFor(()=>expect(element('error').textContent).toContain('could not be completed'));
   expect(element('account').hidden).toBe(true);
 });
 it('initializes an already loaded Clerk script',async()=>{const {element}=fixture();await vi.waitFor(()=>expect(element('status').textContent).toContain('being processed'));expect(element('export').disabled).toBe(true);});
 it('keeps export disabled after processing refresh',async()=>{const {element}=fixture('scheduled');await vi.waitFor(()=>expect(element('status').textContent).toContain('Deletion starts'));await element('cancel').listeners.click();await vi.waitFor(()=>expect(element('cancel').disabled).toBe(false));expect(element('confirm').hidden).toBe(true);});
});
