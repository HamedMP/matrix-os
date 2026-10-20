import { describe, it, expect } from 'vitest';
import { buildSandboxLaunch, sandboxAvailable } from '../../../packages/gateway/src/app-store/build-sandbox.js';
describe('community build sandbox', () => {
  it('hides host roots and credentials and denies networking', () => {
    const launch = buildSandboxLaunch({ source:'/private/source', dependencies:'/private/deps', driver:'/private/driver.mjs', nodeRoot:'/opt/matrix/runtime/node', unit:'matrix-store-build-a123', uid:1000 });
    expect(launch.command).toBe('/usr/bin/systemd-run');
    expect(launch.args).toEqual(expect.arrayContaining(['--property=MemoryMax=1073741824','--property=TasksMax=128','--property=KillMode=control-group','--property=RuntimeMaxSec=120','--unshare-all','--clearenv','--die-with-parent']));
    expect(launch.args).not.toContain('/home/matrix');
    expect(launch.args).not.toContain('/opt/matrix/env');
    expect(launch.env).toEqual({PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'});
    expect(launch.args).not.toContain('--share-net');
  });
  it('fails closed outside Linux or without isolation tools', () => {
    expect(sandboxAvailable({platform:'darwin',uid:1000,exists:()=>true})).toBe(false);
    expect(sandboxAvailable({platform:'linux',uid:1000,exists:()=>false})).toBe(false);
    expect(sandboxAvailable({platform:'linux',uid:1000,exists:()=>true})).toBe(true);
  });
  it('rejects injected systemd paths and units', () => {
    expect(()=>buildSandboxLaunch({source:'/src\nsecret',dependencies:'/deps',driver:'/driver',nodeRoot:'/node',unit:'matrix-store-build-a123',uid:1000})).toThrow();
    expect(()=>buildSandboxLaunch({source:'/src',dependencies:'/deps',driver:'/driver',nodeRoot:'/node',unit:'a --bad',uid:1000})).toThrow();
  });
});
