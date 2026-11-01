import { lstat, realpath, readlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod/v4';
import { MainIsolatedGrant } from '../contracts.mjs';
import { createValidatedQualificationSession } from '../session.mjs';
import { createX11Backend, runBoundedProcess } from '../backend.mjs';

const namespace = prefix => z.string().regex(new RegExp(`^${prefix}:\\[[0-9]+\\]$`));
const Receipt = z.object({
  uid: z.number().int().positive(), gid: z.number().int().positive(), cap_eff: z.literal('0000000000000000'),
  net_namespace: namespace('net'), mount_namespace: namespace('mnt'), pid_namespace: namespace('pid'),
  host_home_visible: z.literal(false), main_x7_visible: z.literal(false),
  x11_dev: z.number().int().nonnegative(), x11_ino: z.number().int().positive(),
}).strict();
/** @returns {Promise<{uid: number, gid: number, net_namespace: string, mount_namespace: string, pid_namespace: string, x11: {dev: number, ino: number}}>} */
async function inspectCurrentHost() {
  const [net_namespace, mount_namespace, pid_namespace, x11] = await Promise.all([
    readlink('/proc/self/ns/net'), readlink('/proc/self/ns/mnt'), readlink('/proc/self/ns/pid'), lstat('/tmp/.X11-unix/X7'),
  ]);
  if (!x11.isSocket()) throw new Error('qualification_unavailable');
  return { uid: process.getuid?.(), gid: process.getgid?.(), net_namespace, mount_namespace, pid_namespace, x11 };
}
const unavailable = () => { throw new Error('qualification_unavailable'); };

/** Trusted operator factory only. Model input is limited to the existing Action schema.
 * actualTarget comes from the guardian's verified Main host identity, not from a tool argument.
 * Manifest/dependency digest verification belongs to the guardian before sandbox startup.
 */
export async function createMainIsolatedSession({ grant: raw, receipt: rawReceipt, actualTarget, bundlePath, statePath,
  platform = process.platform, now = Date.now, inspectHost = inspectCurrentHost, run = runBoundedProcess }) {
  const grant = Object.freeze(MainIsolatedGrant.parse(raw)), receipt = Receipt.parse(rawReceipt);
  if (platform !== 'linux') unavailable();
  const host = await inspectHost();
  if (!host.uid || receipt.uid !== host.uid || receipt.gid !== host.gid ||
    actualTarget?.ownerId !== grant.ownerId || actualTarget?.targetId !== grant.targetId ||
    grant.expiresAt <= now() || grant.expiresAt > now() + 600_000 ||
    ['net_namespace', 'mount_namespace', 'pid_namespace'].some(key => receipt[key] === host[key])) unavailable();
  // Canonical roots and every traversed state component must be owned, non-symlink directories.
  const bundle = await realpath(bundlePath), state = await realpath(statePath);
  for (const path of [bundlePath, statePath, join(state, 'desktop'), join(state, 'desktop', 'x11'), join(bundle, 'code'), join(bundle, 'deps')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== host.uid || (stat.mode & 0o022)) unavailable();
  }
  if ((await lstat(state)).mode & 0o077) unavailable();
  if (resolve(bundlePath) !== bundle || resolve(statePath) !== state || bundle === state || bundle.startsWith(`${state}/`) || state.startsWith(`${bundle}/`)) unavailable();
  const socketDirectory = join(state, 'desktop', 'x11'), socket = join(socketDirectory, 'X7');
  const verifySocket = async () => {
    const directory = await lstat(socketDirectory), stat = await lstat(socket);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== host.uid || (directory.mode & 0o022) ||
      !stat.isSocket() || stat.isSymbolicLink() || stat.uid !== host.uid ||
      stat.dev !== receipt.x11_dev || stat.ino !== receipt.x11_ino ||
      (stat.dev === host.x11.dev && stat.ino === host.x11.ino)) unavailable();
  };
  await verifySocket();
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const invoke = async (program, args, options = {}) => {
    await verifySocket();
    const argv = [
      '--unshare-user', '--uid', String(host.uid), '--gid', String(host.gid), '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
      '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--dir', '/etc', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/run', '--dir', '/home/test',
      '--dir', '/qual', '--ro-bind', join(bundle, 'code'), '/qual/code', '--ro-bind', join(bundle, 'deps'), '/qual/deps',
      '--ro-bind', socketDirectory, '/tmp/.X11-unix', '--chdir', '/home/test',
      '--setenv', 'HOME', '/home/test', '--setenv', 'DISPLAY', ':7', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
      '--setenv', 'LD_LIBRARY_PATH', '/qual/deps/root/usr/lib/x86_64-linux-gnu', '--', program, ...args,
    ];
    return run('/usr/bin/bwrap', argv, { ...options, env });
  };
  const backend = createX11Backend({ platform, uid: host.uid, run: (file, args, options) => {
    if (file === '/usr/bin/xdotool') return invoke('/qual/deps/root/usr/bin/xdotool', args, options);
    if (file === '/usr/bin/python3' && args.length === 2 && args[0] === '-I' && args[1].endsWith('/capture.py')) {
      return invoke('/usr/bin/python3', ['-I', '-c', "import sys,runpy;sys.path.insert(0,'/qual/deps/mss.whl');runpy.run_path('/qual/code/capture.py',run_name='__main__')"], options);
    }
    unavailable();
  } });
  const session = createValidatedQualificationSession({ grant, backend, platform, now });
  return { ...session,
    // Trusted viewer arbitration; never added to Action or registered as a model tool.
    async setHumanControl(enabled) {
      if (typeof enabled !== 'boolean') unavailable();
      const value = enabled ? '1' : '0', options = { signal: AbortSignal.timeout(2000), maxBytes: 64 };
      try {
        for (const name of ['AcceptPointerEvents', 'AcceptKeyEvents']) await invoke('/usr/bin/kasmvncconfig', ['-display', ':7', '-set', `${name}=${value}`], options);
        for (const name of ['AcceptPointerEvents', 'AcceptKeyEvents']) {
          const result = (await invoke('/usr/bin/kasmvncconfig', ['-display', ':7', '-get', name], options)).toString('utf8').trim().toLowerCase();
          if (![value, enabled ? 'true' : 'false'].includes(result)) unavailable();
        }
      } catch (error) {
        console.warn('[computer-qualification] viewer_gate_failed', error instanceof Error ? error.name : 'UnknownError');
        await session.stop(); unavailable();
      }
    },
  };
}
