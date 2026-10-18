import {describe,it,expect} from 'vitest';
import {communityRuntimeCsp} from '../../../packages/gateway/src/app-store/community-csp.js';
describe('community asset confinement',()=>{
 it('allows only exact trusted app asset prefixes and denies raw networking',()=>{
  const csp=communityRuntimeCsp('sample',{origin:'https://app.matrix-os.com',handle:'fixture'});
  expect(csp).toContain("connect-src 'none'");expect(csp).not.toContain("'self'");
  expect(csp).toContain('https://app.matrix-os.com/apps/sample/');expect(csp).toContain('https://app.matrix-os.com/vm/fixture/apps/sample/');
  expect(csp).not.toContain('https:;');expect(csp).toContain("frame-src 'none'");
 });
 it.each(['https://evil.test/path','http://app.matrix-os.com','https://app.matrix-os.com?x=1'])('fails closed for invalid trusted config %s',origin=>{expect(()=>communityRuntimeCsp('sample',{origin,handle:'fixture'})).toThrow();});
 it('rejects invalid identifiers',()=>{expect(()=>communityRuntimeCsp('../sibling',{origin:'https://app.matrix-os.com',handle:'fixture'})).toThrow();expect(()=>communityRuntimeCsp('sample',{origin:'https://app.matrix-os.com',handle:'x/../evil'})).toThrow();});
});
