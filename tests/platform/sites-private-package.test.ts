import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { build, type RollupOutput } from 'vite';
import { packagePrivateSiteHtml } from '../../packages/platform/src/sites/private-package.js';

const bytes = (value: string) => Buffer.from(value);

describe('private site package', () => {
  it('embeds a Vite module graph, styles, fonts, and images without private asset requests', async () => {
    const files = [
      { path: 'index.html', contentType: 'text/html', body: bytes('<!doctype html><html><head><link rel="modulepreload" href="./assets/chunk.js"><link rel="stylesheet" href="./assets/app.css"><script type="module" src="./assets/main.js"></script></head><body><img src="./assets/logo.png"></body></html>') },
      { path: 'assets/main.js', contentType: 'text/javascript', body: bytes('import { answer } from "./chunk.js"; const logo = new URL("./logo.png", import.meta.url); window.result = [answer, logo.href];') },
      { path: 'assets/chunk.js', contentType: 'text/javascript', body: bytes('export const answer = 42;') },
      { path: 'assets/app.css', contentType: 'text/css', body: bytes('@font-face{font-family:x;src:url("./font.woff2")}body{background:url(./logo.png)}') },
      { path: 'assets/logo.png', contentType: 'image/png', body: Buffer.from([1, 2, 3]) },
      { path: 'assets/font.woff2', contentType: 'font/woff2', body: Buffer.from([4, 5, 6]) },
    ];
    const html = await packagePrivateSiteHtml(files, 'index.html');
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain('data:image/png;base64,AQID');
    const stylesheet = html.match(/<link rel="stylesheet" href="data:text\/css;base64,([^"]+)">/)?.[1];
    const css = Buffer.from(stylesheet!, 'base64').toString('utf8');
    expect(css).toContain('data:font/woff2;base64,BAUG');
    expect(css).toContain('data:image/png;base64,AQID');
    expect(html).not.toContain('rel="modulepreload"');
    expect(html).not.toMatch(/(?:src|href)="\.\/assets\//);
    const mapText = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    const imports = JSON.parse(mapText!).imports as Record<string, string>;
    expect(Object.keys(imports)).toEqual(expect.arrayContaining(['matrix-site:assets/main.js', 'matrix-site:assets/chunk.js']));
    const main = Buffer.from(imports['matrix-site:assets/main.js']!.split(',')[1]!, 'base64').toString('utf8');
    expect(main).toContain('matrix-site:assets/chunk.js');
    expect(main).toContain('data:image/png;base64,AQID');
    expect(main).toContain('new URL("data:image/png;base64,AQID", import.meta.url)');
  });

  it('fails closed when a private module references a missing local build artifact', async () => {
    await expect(packagePrivateSiteHtml([
      { path: 'index.html', contentType: 'text/html', body: bytes('<script type="module" src="./main.js"></script>') },
      { path: 'main.js', contentType: 'text/javascript', body: bytes('import "./missing.js";') },
    ], 'index.html')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('keeps literal dynamic imports valid while sealing their local chunks', async () => {
    const html = await packagePrivateSiteHtml([
      { path: 'index.html', contentType: 'text/html', body: bytes('<script type="module" src="./main.js"></script>') },
      { path: 'main.js', contentType: 'text/javascript', body: bytes('window.chunk = import("./chunk.js");') },
      { path: 'chunk.js', contentType: 'text/javascript', body: bytes('export default 42;') },
    ], 'index.html');
    const mapText = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    const imports = JSON.parse(mapText!).imports as Record<string, string>;
    const main = Buffer.from(imports['matrix-site:main.js']!.split(',')[1]!, 'base64').toString('utf8');
    expect(main).toContain('import("matrix-site:chunk.js")');
  });

  it('preserves linked stylesheet order and does not eagerly activate unlinked lazy styles', async () => {
    const html = await packagePrivateSiteHtml([
      { path: 'index.html', contentType: 'text/html', body: bytes('<link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/override.css"><script type="module" src="/assets/main.js"></script>') },
      { path: 'assets/lazy.css', contentType: 'text/css', body: bytes('body{color:green}') },
      { path: 'assets/override.css', contentType: 'text/css', body: bytes('body{color:blue}') },
      { path: 'assets/base.css', contentType: 'text/css', body: bytes('body{color:red}') },
      { path: 'assets/lazy.js', contentType: 'text/javascript', body: bytes('export default true;') },
      { path: 'assets/main.js', contentType: 'text/javascript', body: bytes('const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/lazy.css","assets/lazy.js"])))=>i.map(i=>d[i]); window.loadStyle = () => import("./lazy.css");') },
    ], 'index.html');
    const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]!);
    expect(hrefs).toHaveLength(2);
    expect(Buffer.from(hrefs[0]!.split(',')[1]!, 'base64').toString('utf8')).toBe('body{color:red}');
    expect(Buffer.from(hrefs[1]!.split(',')[1]!, 'base64').toString('utf8')).toBe('body{color:blue}');
    const mapText = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    const imports = JSON.parse(mapText!).imports as Record<string, string>;
    const lazyModule = Buffer.from(imports['matrix-site:assets/lazy.css']!.split(',')[1]!, 'base64').toString('utf8');
    expect(lazyModule).toContain("document.createElement('link')");
    const main = Buffer.from(imports['matrix-site:assets/main.js']!.split(',')[1]!, 'base64').toString('utf8');
    expect(main).toContain('data:text/css;base64,');
    expect(main).toContain('data:text/javascript,export{}');
  });

  it('does not interpret ordinary quoted app strings as build artifact paths', async () => {
    const html = await packagePrivateSiteHtml([
      { path: 'index.html', contentType: 'text/html', body: bytes('<script type="module" src="./assets/main.js"></script>') },
      { path: 'assets/main.js', contentType: 'text/javascript', body: bytes('window.navigate("../.."); window.label = "/assets/logo.png"; window.template = "<img src=\'/assets/logo-ABCdef12.svg\'>";') },
      { path: 'assets/logo.png', contentType: 'image/png', body: Buffer.from([1, 2, 3]) },
      { path: 'assets/logo-ABCdef12.svg', contentType: 'image/svg+xml', body: bytes('<svg/>') },
    ], 'index.html');
    const mapText = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    const imports = JSON.parse(mapText!).imports as Record<string, string>;
    const main = Buffer.from(imports['matrix-site:assets/main.js']!.split(',')[1]!, 'base64').toString('utf8');
    expect(main).toContain('window.navigate("../..")');
    expect(main).toContain('window.label = "/assets/logo.png"');
    expect(main).toContain('window.template = "<img src=\'/assets/logo-ABCdef12.svg\'>"');
    expect(() => new Function(main)).not.toThrow();
  });

  it('embeds an image imported by an actual default-base Vite build', async () => {
    const result = await build({
      root: fileURLToPath(new URL('../fixtures/sites-private-vite', import.meta.url)),
      logLevel: 'silent',
      build: { write: false, assetsInlineLimit: 0 },
    }) as RollupOutput;
    const files = result.output.map(item => {
      const body = item.type === 'chunk' ? Buffer.from(item.code) : Buffer.from(item.source);
      const contentType = item.fileName.endsWith('.html') ? 'text/html'
        : item.fileName.endsWith('.js') ? 'text/javascript'
          : item.fileName.endsWith('.svg') ? 'image/svg+xml'
            : 'application/octet-stream';
      return { path: item.fileName, contentType, body };
    });
    const html = await packagePrivateSiteHtml(files, 'index.html');
    const mapText = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    const imports = JSON.parse(mapText!).imports as Record<string, string>;
    const mainEntry = Object.entries(imports).find(([path]) => /^matrix-site:assets\/index-.*\.js$/.test(path));
    const main = Buffer.from(mainEntry![1].split(',')[1]!, 'base64').toString('utf8');
    expect(main).toContain('data:image/svg+xml;base64,');
    expect(main).not.toMatch(/["']\/assets\/logo-[A-Za-z0-9_-]+\.svg["']/);
  });

  it('rejects repeated resource expansion before constructing an oversized output', async () => {
    const image = Buffer.alloc(1024 * 1024, 1);
    const references = Array.from({ length: 1000 }, () => '<img src="./large.png">').join('');
    await expect(packagePrivateSiteHtml([
      { path: 'index.html', contentType: 'text/html', body: bytes(references) },
      { path: 'large.png', contentType: 'image/png', body: image },
    ], 'index.html')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('stops producing repeated module asset expansions when the output budget is exhausted', async () => {
    const assetPath = '/assets/logo-ABCdef12.png';
    const references = Array.from({ length: 30 }, () => JSON.stringify(assetPath)).join(',');
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      await expect(packagePrivateSiteHtml([
        { path: 'index.html', contentType: 'text/html', body: bytes('<script type="module" src="./assets/main.js"></script>') },
        { path: 'assets/main.js', contentType: 'text/javascript', body: bytes(`window.assets=[${references}]`) },
        { path: 'assets/logo-ABCdef12.png', contentType: 'image/png', body: Buffer.alloc(1024 * 1024, 1) },
      ], 'index.html')).rejects.toMatchObject({ code: 'unavailable' });
      const expandedAssets = stringify.mock.calls.filter(([value]) => typeof value === 'string' && value.startsWith('data:image/png;base64,'));
      expect(expandedAssets.length).toBeLessThan(20);
    }
    finally { stringify.mockRestore(); }
  });
});
