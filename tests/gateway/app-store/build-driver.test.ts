import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { it, expect } from 'vitest';
import { STORE_BUILD_DRIVER } from '../../../packages/gateway/src/app-store/build-driver.js';
const run = promisify(execFile);

it('collects the fixed dist output when an actual Vite project configures a nested root', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'matrix-store-nested-root-'));
  try {
    const source = join(scratch, 'source');
    const workspace = join(scratch, 'workspace');
    await mkdir(join(source, 'web'), { recursive: true });
    await mkdir(join(source, 'node_modules'), { recursive: true });
    await writeFile(join(source, 'package.json'), '{"type":"module"}');
    await writeFile(join(source, 'vite.config.js'), "export default {root:'web'};");
    await writeFile(join(source, 'web/index.html'), '<div>Nested source</div><script type="module" src="./main.js"></script>');
    await writeFile(join(source, 'web/main.js'), "document.body.dataset.built='yes';");
    const require = createRequire(import.meta.url);
    await symlink(dirname(require.resolve('vite/package.json')), join(source, 'node_modules/vite'));
    const install = join(scratch, 'pnpm-install-fixture');
    // Dependency installation is outside this regression; execute the real Vite build.
    await writeFile(install, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const driver = STORE_BUILD_DRIVER.replaceAll('/workspace', workspace).replaceAll('/source', source)
      .replaceAll('/opt/matrix/runtime/node/bin/pnpm', install).replaceAll('/opt/matrix/runtime/node/bin/node', process.execPath);
    await writeFile(join(scratch, 'driver.mjs'), driver);
    const result = await run(process.execPath, [join(scratch, 'driver.mjs')], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const files = JSON.parse(result.stdout) as Array<{ path: string; data: string }>;
    expect(Buffer.from(files.find(file => file.path === 'index.html')!.data, 'base64').toString()).toContain('Nested source');
    expect(files.some(file => file.path.startsWith('assets/') && file.path.endsWith('.js'))).toBe(true);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
