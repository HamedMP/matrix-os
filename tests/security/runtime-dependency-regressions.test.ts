import { createRequire } from 'node:module';
import { tokenizer } from 'acorn';
import { JSDOM } from 'jsdom';
import { createManualModuleSource } from '@vitest/mocker/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Resolve through real workspace dependency edges. No provider/network calls or
// synthetic substitute implementations: these exercise the installed packages.
const platform = createRequire(new URL('../../packages/platform/package.json', import.meta.url));
const gateway = createRequire(new URL('../../packages/gateway/package.json', import.meta.url));
const root = createRequire(new URL('../../package.json', import.meta.url));
const mcp = createRequire(platform.resolve('@modelcontextprotocol/sdk/server/index.js'));
const express = createRequire(mcp.resolve('express'));
const proxyAddress = express('proxy-addr') as { compile(subnets: string[]): (address: string) => boolean };
const ink = createRequire(root.resolve('ink'));
const devtools = createRequire(ink.resolve('react-devtools-core'));
const shellQuote = devtools('shell-quote') as { quote(tokens: unknown[]): string };
const telegram = createRequire(gateway.resolve('node-telegram-bot-api'));
const cypressRequest = createRequire(telegram.resolve('@cypress/request-promise'));
const promiseCore = createRequire(cypressRequest.resolve('request-promise-core'));
const legacyRequest = createRequire(promiseCore.resolve('request'));
const FormData = legacyRequest('form-data') as new () => { getBoundary(): string };

afterEach(() => vi.restoreAllMocks());
describe('runtime dependency security regressions', () => {
  it('keeps a manual mock URL as one string literal instead of executable module statements', () => {
    const url = 'x"); globalThis.syntheticInjected = true; void("';
    const source = createManualModuleSource(url, ['synthetic']);
    const tokens = [...tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' })];
    expect(tokens.filter(token => token.type.label === 'string').map(token => token.value)).toContain(url);
    expect(tokens.some(token => token.type.label === 'name' && token.value === 'syntheticInjected')).toBe(false);
  });
  it('scrubs template expressions split across attached shadow-root text nodes', () => {
    const desktop = createRequire(new URL('../../desktop/package.json', import.meta.url));
    const monaco = createRequire(desktop.resolve('monaco-editor'));
    const window = new JSDOM('').window;
    try {
      const purify = monaco('dompurify')(window);
      const host = window.document.createElement('div'); const shadow = host.attachShadow({ mode: 'open' });
      shadow.append(window.document.createTextNode('$'), window.document.createElement('object'), window.document.createTextNode('{syntheticExpression}'));
      purify.sanitize(host, { IN_PLACE: true, SAFE_FOR_TEMPLATES: true }); shadow.normalize();
      expect(shadow.textContent).not.toContain('${syntheticExpression}');
      expect(purify.sanitize('<p>Ordinary <b>content</b><script>synthetic</script></p>')).toBe('<p>Ordinary <b>content</b></p>');
    } finally { window.close(); }
  });
  it('never trusts an arbitrary IPv4 client through a short IPv4-mapped IPv6 subnet', () => {
    const trust = proxyAddress.compile(['::ffff:10.0.0.0/8']);
    expect(trust('203.0.113.44')).toBe(false);
    expect(proxyAddress.compile(['10.0.0.0/8'])('10.1.2.3')).toBe(true);
    expect(proxyAddress.compile(['10.0.0.0/8'])('203.0.113.44')).toBe(false);
  });
  it('rejects shell operator objects containing a command-separating newline', () => {
    expect(() => shellQuote.quote([{ op: ';\nsynthetic-command' }])).toThrow(TypeError);
    expect(shellQuote.quote(['ordinary filename.txt'])).toBe("'ordinary filename.txt'");
  });
  it.each(['\n', '\r', '\u2028', '\u2029'])('refuses line terminator %j after a shell comment token', separator => {
    expect(() => shellQuote.quote(['echo', 'ordinary', { comment: 'comment' }, `a${separator}synthetic-command;#`])).toThrow(TypeError);
  });
  it('does not derive multipart boundaries from predictable Math.random values', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = new FormData().getBoundary();
    const second = new FormData().getBoundary();
    expect(first).not.toBe(second);
  });
});
