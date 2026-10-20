// @vitest-environment jsdom
import {describe,it,expect} from 'vitest';
import {injectBridgeIntoAppHtml} from '../../shell/src/components/app-viewer-helpers.js';
describe('structural untrusted app HTML injection',()=>{
 it.each([
  '<!-- <head> --><html><head><script>window.untrusted=true</script></head><body>Hi</body></html>',
  '<html><head data-value="> malformed"><script>window.untrusted=true</script></head><body>Hi</body></html>',
  '<html><head></head><head><base href="https://attacker.test/"><script>window.untrusted=true</script></head><body>Hi</body></html>',
  '<!-- <head> --><script>window.untrusted=true</script><body><base href="https://attacker.test/"></body>',
 ])('places the enforced CSP and bridge before any untrusted script: %s',html=>{
  const output=injectBridgeIntoAppHtml(html,'fixture',{},'https://app.matrix-os.com/apps/fixture/',undefined,{token:'fixed-test-nonce',community:true});
  const parsed=new DOMParser().parseFromString(output,'text/html');const head=parsed.head;
  expect(head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
  expect(head.firstElementChild?.getAttribute('content')).toContain("connect-src 'none'");
  expect(parsed.querySelectorAll('base')).toHaveLength(1);expect(head.querySelector('base')?.href).toBe('https://app.matrix-os.com/apps/fixture/');
  const scripts=[...parsed.querySelectorAll('script')];expect(scripts[0].textContent).toContain('fixed-test-nonce');expect(scripts[0].textContent).toContain('window.MatrixOS');
 });
});
