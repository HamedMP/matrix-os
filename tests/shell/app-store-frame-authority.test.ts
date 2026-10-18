import {describe,it,expect} from 'vitest';
import {isCurrentAppFrame,communityIframeSandbox,communityDocumentPolicy} from '../../shell/src/components/app-frame-authority';
describe('per-document bridge authority',()=>{
 it('rejects a navigated document retaining the same WindowProxy without the current nonce',()=>{
  const source={};const expected={source,app:'apps/app-gallery',token:'new-document'};
  expect(isCurrentAppFrame({source,origin:'null',data:{app:'apps/app-gallery',bridgeToken:'old-document'}} as never,expected as never)).toBe(false);
  expect(isCurrentAppFrame({source,origin:'null',data:{app:'apps/app-gallery'}} as never,expected as never)).toBe(false);
  expect(isCurrentAppFrame({source,origin:'null',data:{app:'apps/app-gallery',bridgeToken:'new-document'}} as never,expected as never)).toBe(true);
 });
 it('does not grant forms, popups, or downloads to community code',()=>{
  expect(communityIframeSandbox(true)).toBe('allow-scripts');expect(communityDocumentPolicy).toContain("form-action 'none'");expect(communityDocumentPolicy).toContain("frame-src 'none'");
 });
});
