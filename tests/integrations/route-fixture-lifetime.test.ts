import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('does not retain a disposed route database through the label cleanup timer', () => {
  const source = new URL('../../packages/gateway/src/integrations/routes.ts', import.meta.url).href;
  const script = `
    import { createIntegrationRoutes } from ${JSON.stringify(source)};
    import { setImmediate } from 'node:timers/promises';
    let db = {}; const reference = new WeakRef(db);
    createIntegrationRoutes({db, pipedream:{getAppInfo:async()=>null}, webhookSecret:'fixture', resolveUserId:async()=>null});
    db = null; await setImmediate(); global.gc(); await setImmediate(); global.gc();
    if(reference.deref()) { console.error('Route timer retains its database'); process.exitCode=1; }
  `;
  const result = spawnSync(process.execPath, ['--expose-gc','--import','tsx','--input-type=module','-e',script], { encoding:'utf8', timeout:15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
