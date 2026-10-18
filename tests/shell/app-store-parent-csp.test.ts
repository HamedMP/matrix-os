import {describe,it,expect} from 'vitest';
import config from '../../shell/next.config';
import {buildRendererCsp} from '../../desktop/src/main/auth/header-injection';
describe('app parent navigation boundary',()=>{
 it('sets the OS root frame policy without changing auth pages',async()=>{
  const rules=await config.headers?.();expect(rules).toContainEqual({source:'/',headers:[{key:'Content-Security-Policy',value:"frame-src 'self'"}]});
  expect(rules?.some(rule=>rule.source.includes('sign-in'))).toBe(false);
 });
 it('limits packaged Electron frames to the renderer and its configured gateway',()=>{
  const policy=buildRendererCsp('https://gateway.test','file://');expect(policy).toContain("frame-src 'self' https://gateway.test");expect(policy).not.toContain('frame-src https:');
 });
});
