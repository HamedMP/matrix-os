import { pathToFileURL } from 'node:url';
import { readPrivateDevStackFile } from './local.mjs';
import { createIsolatedStage3TestRunner } from './stage3-isolated-runner.mjs';
import { createStage3Publisher, listenStage3Publisher } from './stage3-publisher.mjs';

export async function startStage3Publisher(configPath) {
  const config = await readPrivateDevStackFile(configPath, 32 * 1024);
  if (config?.version !== 1 || Object.keys(config).sort().join(',') !== 'enrollment,socketPath,stateDir,test,version') {
    throw new Error('Invalid DevStack publisher configuration.');
  }
  const testRevision = createIsolatedStage3TestRunner(config.test);
  const publisher = createStage3Publisher({ enrollment: config.enrollment, stateDir: config.stateDir, testRevision });
  return listenStage3Publisher({ socketPath: config.socketPath, publisher });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The dedicated service must not pass operational credentials to Git or any
  // future subprocess. Only a fixed binary path survives startup.
  for (const name of Object.keys(process.env)) delete process.env[name];
  process.env.PATH = '/usr/bin:/bin';
  process.env.HOME = '/nonexistent';
  if (process.argv.length !== 3) throw new Error('A private publisher configuration path is required.');
  const server = await startStage3Publisher(process.argv[2]);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void server.close().catch(error => {
      console.error('[devstack-publisher] shutdown failed', error instanceof Error ? error.name : 'Unknown');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
