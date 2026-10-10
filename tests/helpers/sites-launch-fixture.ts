import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { collectSiteFiles } from '../../packages/gateway/src/sites/bundle.js';
import { SitePublishingSchema } from '../../packages/contracts/src/sites.js';

/** Real React/Vite build; uses the workspace dependencies without downloading fixture packages. */
export async function buildLaunchSite() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'matrix-launch-site-')));
  try {
    await cp(join(repo, 'tests/fixtures/apps/public-launch'), dir, { recursive: true });
    await build({ root: dir, configFile: false, base: './', logLevel: 'silent',
      resolve: { alias: { 'react-dom': join(repo, 'node_modules/react-dom'), react: join(repo, 'node_modules/react') } },
      esbuild: { jsx: 'transform' }, build: { outDir: 'dist', sourcemap: false },
    });
    const manifest = JSON.parse(await readFile(join(dir, 'matrix.json'), 'utf8'));
    return { dir, deployment: { title: manifest.name, description: manifest.description, config: SitePublishingSchema.parse(manifest.publishing), files: await collectSiteFiles(dir, 'dist') }, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
