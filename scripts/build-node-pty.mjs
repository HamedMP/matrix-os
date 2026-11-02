import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const nodePtyRoot = dirname(require.resolve('node-pty/package.json'));
const nodeGypPath = require.resolve('node-gyp/bin/node-gyp.js', {
  paths: [nodePtyRoot],
});
const nativeModulePath = join(nodePtyRoot, 'build', 'Release', 'pty.node');

const build = spawnSync(process.execPath, [nodeGypPath, 'rebuild'], {
  cwd: nodePtyRoot,
  env: {
    ...process.env,
    npm_config_build_from_source: 'true',
  },
  stdio: 'inherit',
});

if (build.error) {
  console.error('[build-node-pty] failed to start node-gyp');
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(nativeModulePath)) {
  console.error('[build-node-pty] node-gyp completed without pty.node');
  process.exit(1);
}

try {
  require('node-pty');
} catch (error) {
  console.error(
    '[build-node-pty] rebuilt native module failed to load',
    error instanceof Error ? error.stack ?? error.message : error,
  );
  process.exit(1);
}

console.log('[build-node-pty] native module rebuilt and loaded');
