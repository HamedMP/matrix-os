import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, lstat, rm, unlink, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { createMainIsolatedSession } from '../../scripts/spikes/computer-use/isolation/backend.mjs';
import { createQualificationSession } from '../../scripts/spikes/computer-use/session.mjs';
import { runBoundedProcess } from '../../scripts/spikes/computer-use/backend.mjs';
type RunOptions = NonNullable<Parameters<typeof runBoundedProcess>[2]>;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cu-main-'))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle'), statePath = join(root, 'state');
  await mkdir(bundlePath, { mode: 0o700 }); await mkdir(join(statePath, 'desktop', 'x11'), { recursive: true, mode: 0o700 });
  await mkdir(join(bundlePath, 'code'), { mode: 0o700 }); await mkdir(join(bundlePath, 'deps'), { mode: 0o700 });
  const socket = join(statePath, 'desktop', 'x11', 'X7');
  const servers: Server[] = [];
  const listen = async (path: string) => { const s = createServer(); await new Promise<void>(resolve => s.listen(path, resolve)); servers.push(s); };
  await listen(socket); cleanup.push(async () => { await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve())))); });
  const stat = await lstat(socket), uid = process.getuid!(), gid = process.getgid!();
  const host = { uid, gid, net_namespace: 'net:[1]', mount_namespace: 'mnt:[1]', pid_namespace: 'pid:[1]', x11: { dev: stat.dev, ino: stat.ino + 1 } };
  const receipt = { uid, gid, cap_eff: '0000000000000000', net_namespace: 'net:[2]', mount_namespace: 'mnt:[2]', pid_namespace: 'pid:[2]', host_home_visible: false, main_x7_visible: false, x11_dev: stat.dev, x11_ino: stat.ino };
  const grant = { scope: 'main-isolated', runtimeSlot: 'primary', ownerId: 'owner', chatId: 'chat', runId: 'run', targetId: 'main_target', display: ':7', modelRoute: 'codex', syntheticOnly: true, expiresAt: Date.now() + 60_000 };
  const calls: Array<{ file: string; args: string[]; options: RunOptions }> = [];
  const run = async (file: string, args: string[], options: RunOptions = {}) => {
    calls.push({ file, args, options });
    if (args.includes('getdisplaygeometry')) return Buffer.from('1 1');
    if (args.includes('/usr/bin/python3')) return Buffer.from(JSON.stringify({ width: 1, height: 1, data: png }));
    if (args.includes('-get')) return Buffer.from('0\n');
    return Buffer.from('');
  };
  return { root, socket, listen, grant, receipt, bundlePath, statePath, actualTarget: { ownerId: 'owner', targetId: 'main_target' }, platform: 'linux' as const, inspectHost: async () => host, host, run, calls };
}
it('admits a proven private Main display while preserving the Preview default denial', async () => {
  const f = await fixture();
  expect(() => createQualificationSession({ grant: f.grant, backend: {}, platform: 'linux' })).toThrow();
  const s = await createMainIsolatedSession(f); cleanup.push(() => s.stop());
  expect(await s.execute({ action: 'status' })).toMatchObject({ active: true, syntheticOnly: true });
  const frame = await s.execute({ action: 'observe' }); expect(frame).toMatchObject({ width: 1, height: 1, data: png });
  if (!('observationId' in frame)) throw new Error('observation required');
  await s.execute({ action: 'click', x: 0, y: 0, actionId: 'click', observationId: frame.observationId, leaseEpoch: frame.leaseEpoch, geometryRevision: frame.geometryRevision });
  for (const c of f.calls) {
    expect(c.file).toBe('/usr/bin/bwrap'); expect(c.args).toContain('--unshare-net'); expect(c.args).toContain('--unshare-pid');
    expect(c.args).toContain(join(f.bundlePath, 'code')); expect(c.args).toContain(join(f.bundlePath, 'deps'));
    expect(c.args).not.toContain(f.bundlePath); expect(c.args).toContain(join(f.statePath, 'desktop', 'x11'));
    expect(c.args).not.toContain(f.statePath); expect(c.args).not.toContain('/tmp/.X11-unix/X7'); expect(c.options.env).not.toHaveProperty('HOME');
  }
  expect(f.calls.some(c => c.args.includes('/qual/deps/root/usr/bin/xdotool') && c.args.includes('mousedown'))).toBe(true);
});
it('rejects absent, mismatched, expired and host-shared proofs before dispatch', async () => {
  const f = await fixture();
  for (const patch of [
    { receipt: undefined }, { actualTarget: { ownerId: 'other', targetId: 'main_target' } },
    { grant: { ...f.grant, expiresAt: 1 } }, { receipt: { ...f.receipt, syntheticOnly: false } },
    { receipt: { ...f.receipt, net_namespace: f.host.net_namespace } }, { receipt: { ...f.receipt, mount_namespace: f.host.mount_namespace } },
    { receipt: { ...f.receipt, pid_namespace: f.host.pid_namespace } }, { grant: { ...f.grant, syntheticOnly: false } },
    { receipt: { ...f.receipt, cap_eff: '0000000000000001' } }, { receipt: { ...f.receipt, uid: 0 } },
    { receipt: { ...f.receipt, x11_ino: f.host.x11.ino } }, { host: null, inspectHost: async () => ({ ...f.host, x11: { dev: f.receipt.x11_dev, ino: f.receipt.x11_ino } }) },
  ]) await expect(createMainIsolatedSession({ ...f, ...patch })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
it('rejects symlinked or replaced sockets rather than falling back to live X7', async () => {
  const f = await fixture(), s = await createMainIsolatedSession(f); cleanup.push(() => s.stop());
  await unlink(f.socket); await symlink('/tmp/.X11-unix/X7', f.socket);
  await expect(s.execute({ action: 'observe' })).rejects.toThrow('qualification_unavailable'); expect(f.calls).toHaveLength(0);
});
it('rejects a newly replaced socket even when it is still owned by the test user', async () => {
  const f = await fixture(), s = await createMainIsolatedSession(f); cleanup.push(() => s.stop());
  await unlink(f.socket); await f.listen(f.socket);
  await expect(s.execute({ action: 'observe' })).rejects.toThrow('qualification_unavailable'); expect(f.calls).toHaveLength(0);
});
it('pins direct kasmvncconfig without alternatives mounts, outside the model action schema, and requires readback', async () => {
  const f = await fixture(), s = await createMainIsolatedSession(f); cleanup.push(() => s.stop());
  await expect(s.execute({ action: 'human_control', enabled: true })).rejects.toThrow();
  await expect(s.execute({ action: 'observe', display: ':7', grant: f.grant })).rejects.toThrow();
  await s.setHumanControl(false);
  expect(f.calls.every(c => !c.args.includes('/usr/bin/vncconfig') && !c.args.includes('/etc/alternatives'))).toBe(true);
  expect(f.calls.filter(c => c.args.includes('/usr/bin/kasmvncconfig')).map(c => c.args.slice(-3))).toEqual([
    [':7', '-set', 'AcceptPointerEvents=0'], [':7', '-set', 'AcceptKeyEvents=0'],
    [':7', '-get', 'AcceptPointerEvents'], [':7', '-get', 'AcceptKeyEvents'],
  ]);
});
it('stops model admission if the VNC gate does not acknowledge the requested state', async () => {
  const f = await fixture();
  const s = await createMainIsolatedSession({ ...f, run: async (...args: Parameters<typeof f.run>) => args[1].includes('-get') ? Buffer.from('1') : f.run(...args) });
  cleanup.push(() => s.stop());
  await expect(s.setHumanControl(false)).rejects.toThrow('qualification_unavailable');
  await expect(s.execute({ action: 'observe' })).rejects.toThrow('qualification_unavailable');
});
