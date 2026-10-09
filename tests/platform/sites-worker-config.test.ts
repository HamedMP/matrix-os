import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('serves the sites hostname as Worker origin without development URLs', () => {
    const config = readFileSync(new URL('../../packages/edge-router/wrangler.sites.toml', import.meta.url), 'utf8');
    expect(config).toMatch(/pattern\s*=\s*"matrix\.page"[^\n]*custom_domain\s*=\s*true/);
    expect(config).toMatch(/^workers_dev\s*=\s*false/m);
    expect(config).toMatch(/^preview_urls\s*=\s*false/m);
});
