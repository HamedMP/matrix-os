import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('serves the sites hostname through its existing DNS zone route without development URLs', () => {
  const config = readFileSync(
    new URL('../../packages/edge-router/wrangler.sites.toml', import.meta.url),
    'utf8',
  );
  expect(config).toMatch(
    /pattern\s*=\s*"matrix\.page\/\*"[^\n]*zone_name\s*=\s*"matrix\.page"/,
  );
  expect(config).not.toMatch(/custom_domain\s*=\s*true/);
  expect(config).toMatch(/^workers_dev\s*=\s*false/m);
  expect(config).toMatch(/^preview_urls\s*=\s*false/m);
});
