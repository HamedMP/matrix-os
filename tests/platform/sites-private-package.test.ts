import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { packagePrivateSiteHtml } from '../../packages/platform/src/sites/private-package.js';

const bytes = (value: string) => Buffer.from(value);

describe('private site package', () => {
  it('embeds a Vite module graph, styles, fonts, and images without private asset requests', async () => {
    const files = [
      { path: 'index.html', contentType: 'text/html', body: bytes('<!doctype html><html><head><link rel="modulepreload" href="./assets/chunk.js"><link rel="stylesheet" href="./assets/app.css"><script type="module" src="./assets/main.js"></script></head><body><img src="./assets/logo.png"></body></html>') },
      { path: 'assets/main.js', contentType: 'text/javascript', body: bytes('import { answer } from "./chunk.js"; const logo = new URL("./logo.png", import.meta.url); window.result = [answer, logo];') },
      { path: 'assets/chunk.js', contentType: 'text/javascript', body: bytes('export const answer = 42;') },
      { path: 'assets/app.css', contentType: 'text/css', body: bytes('@font-face{font-family:x;src:url("./font.woff2")}body{background:url(./logo.png)}') },
      { path: 'assets/logo.png', contentType: 'image/png', body: Buffer.from([1, 2, 3]) },
      { path: 'assets/font.woff2', contentType: 'font/woff2', body: Buffer.from([4, 5, 6]) },
    ];
    const html = await packagePrivateSiteHtml(files, 'index.html');
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain('data:image/png;base64,AQID');
    expect(html).toContain('data:font/woff2;base64,BAUG');
    expect(html).not.toContain('rel="modulepreload"');
    expect(html).not.toMatch(/(?:src|href)="\.\/assets\//);
    const mapText = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    const imports = JSON.parse(mapText!).imports as Record<string, string>;
    expect(Object.keys(imports)).toEqual(expect.arrayContaining(['matrix-site:assets/main.js', 'matrix-site:assets/chunk.js']));
    const main = Buffer.from(imports['matrix-site:assets/main.js']!.split(',')[1]!, 'base64').toString('utf8');
    expect(main).toContain('matrix-site:assets/chunk.js');
    expect(main).toContain('data:image/png;base64,AQID');
    expect(main).not.toContain('import.meta.url');
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
});
