import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink } from 'node:fs/promises';

const executeFile = promisify(execFile);
const chromeProfile = '/home/matrix/.local/share/matrix-browser-lab/chrome';
const matrixHome = '/home/matrix/home';
const env = ownerUid => ({ HOME: '/home/matrix', PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: ':7', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: `/run/user/${ownerUid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${ownerUid}/bus` });
const commandOptions = (signal, ownerUid) => ({ env: env(ownerUid), timeout: 3000, maxBuffer: 16_384, signal: signal ?? AbortSignal.timeout(3000) });
const ACTIONS = ['restore-chrome', 'show-desktop', 'open-files', 'open-terminal'];
export class InvalidBrowserControl extends Error {}

export function parseBrowserControl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'action' || !ACTIONS.includes(value.action)) throw new InvalidBrowserControl('Invalid browser control');
  return value;
}
export function parseBrowserSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'surface' || !['browser', 'desktop'].includes(value.surface)) throw new InvalidBrowserControl('Invalid browser session');
  return value;
}

export function parseWindowProperties(text) {
  if (typeof text !== 'string' || text.length > 16_384) throw new Error('Invalid window metadata');
  const classMatch = text.match(/^WM_CLASS\(STRING\) = "([a-zA-Z0-9_. /()-]{1,160})", "([a-zA-Z0-9_.-]{1,80})"$/m);
  const pidMatch = text.match(/^_NET_WM_PID\(CARDINAL\) = (\d{1,10})$/m);
  const pid = Number(pidMatch?.[1]);
  if (!classMatch || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid window metadata');
  const state = text.match(/^_NET_WM_STATE\(ATOM\) = ([A-Z0-9_, ]*)$/m)?.[1] ?? '';
  const type = text.match(/^_NET_WM_WINDOW_TYPE\(ATOM\) = ([A-Z0-9_, ]*)$/m)?.[1] ?? '';
  return { pid, instance: classMatch[1], className: classMatch[2], minimized: state.split(', ').includes('_NET_WM_STATE_HIDDEN'), normal: type.split(', ').includes('_NET_WM_WINDOW_TYPE_NORMAL') };
}

async function nativeInspectProcess(pid) {
  try {
    const [stat, exe, args, cgroup] = await Promise.all([
      lstat(`/proc/${pid}`), readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`), readFile(`/proc/${pid}/cgroup`, 'utf8'),
    ]);
    if (args.length > 65_536 || cgroup.length > 8192) throw new Error('Process metadata limit');
    return { uid: stat.uid, exe, arguments: args.toString('utf8').split('\0').filter(Boolean), cgroup };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

function hasFixedChromeProfile(arguments_) {
  if (arguments_.length === 1) {
    const title = arguments_[0];
    if (title.length > 4096 || /[\x00-\x08\x0a-\x1f\x7f]/.test(title)) return false;
    const tokens = title.split(/[ \t]+/);
    if (tokens.length > 64 || tokens[0] !== '/opt/google/chrome/chrome') return false;
    arguments_ = tokens;
  }
  // Chrome launch wrappers may emit either spelling; exactly one switch is
  // required so a later conflicting profile cannot override the accepted one.
  const flags = arguments_.flatMap((argument, index) => argument === '--user-data-dir' ? [arguments_[index + 1]]
    : argument.startsWith('--user-data-dir=') ? [argument.slice('--user-data-dir='.length)] : []);
  return flags.length === 1 && flags[0] === chromeProfile;
}

export async function launchNativeApp(file, args, options, execute = executeFile) {
  options.signal.throwIfAborted();
  const unit = file === '/usr/bin/thunar' && JSON.stringify(args) === JSON.stringify([matrixHome]) ? 'files'
    : file === '/usr/bin/xfce4-terminal' && JSON.stringify(args) === JSON.stringify(['--disable-server', `--working-directory=${matrixHome}`]) ? 'terminal' : null;
  if (!unit || options.cwd !== matrixHome) throw new Error('Invalid native launch');
  // A transient user service has its own cgroup and survives supervisor updates.
  // Two fixed names prevent unbounded launches; normal exit collects each unit.
  await execute('/usr/bin/systemd-run', ['--user', '--collect', '--no-block', `--unit=matrix-browser-lab-${unit}.service`, '--service-type=exec',
    `--working-directory=${matrixHome}`, '--setenv=DISPLAY=:7', '--setenv=HOME=/home/matrix', '--setenv=LANG=C.UTF-8',
    '--property=MemoryMax=512M', '--property=TasksMax=128', '--property=TimeoutStopSec=5s', '--property=NoNewPrivileges=yes', '--property=KillMode=control-group', '--', file, ...args], options);
}

export function createNativeWindows({ execute = executeFile, launch = launchNativeApp, inspectProcess = nativeInspectProcess, ownerUid = process.getuid() } = {}) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0 || ownerUid > 2_147_483_647) throw new Error('Invalid native owner');
  const options = signal => commandOptions(signal, ownerUid);
  // Fixed two launch slots, each expires after five seconds; not a general registry.
  const launchCooldown = { files: 0, terminal: 0 };
  const identities = {
    chrome: { instance: 'google-chrome', className: 'Google-chrome', exe: '/opt/google/chrome/chrome' },
    files: { instance: 'thunar', className: 'Thunar', exe: '/usr/bin/thunar' },
    terminal: { instance: 'xfce4-terminal', className: 'Xfce4-terminal', exe: '/usr/bin/xfce4-terminal' },
  };
  const metadata = async (id, signal) => {
    const { stdout } = await execute('/usr/bin/xprop', ['-display', ':7', '-id', id, 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE', '_NET_WM_WINDOW_TYPE'], options(signal));
    try { return parseWindowProperties(stdout); }
    catch (error) { if (error instanceof Error && error.message === 'Invalid window metadata') return null; throw error; }
  };
  const owned = async (id, app, signal) => {
    const window = await metadata(id, signal); const identity = identities[app];
    const instanceMatches = window && (window.instance.toLowerCase() === identity.instance.toLowerCase()
      || app === 'chrome' && window.instance === `google-chrome (${chromeProfile})`);
    if (!window || !window.normal || !instanceMatches || window.className.toLowerCase() !== identity.className.toLowerCase()) return null;
    const process = await inspectProcess(window.pid);
    if (!process || process.uid !== ownerUid || process.exe !== identity.exe) return null;
    if (app === 'chrome' && (!hasFixedChromeProfile(process.arguments) || !process.cgroup.split('\n').some(line => /^\d+:[^:]*:\/system.slice\/matrix-browser-lab-chrome\.service(?:\/[^\n]*)?$/.test(line)))) return null;
    return window;
  };
  const find = async (app, signal) => {
    const { stdout } = await execute('/usr/bin/xprop', ['-display', ':7', '-root', '_NET_CLIENT_LIST'], options(signal));
    if (stdout.length > 16_384) throw new Error('Window metadata limit');
    const ids = stdout.match(/0x[a-fA-F0-9]+/g) ?? [];
    if (ids.length > 32) throw new Error('Window count limit');
    for (const id of ids) if (await owned(id, app, signal)) return id;
    return null;
  };
  const restore = async (id, app, signal) => {
    if (!await owned(id, app, signal)) throw new Error('Native window unavailable');
    await execute('/usr/bin/wmctrl', ['-k', 'off'], options(signal));
    if (!await owned(id, app, signal)) throw new Error('Native window unavailable');
    await execute('/usr/bin/wmctrl', ['-ia', id], options(signal));
    if (app === 'chrome') {
      if (!await owned(id, app, signal)) throw new Error('Native window unavailable');
      await execute('/usr/bin/wmctrl', ['-ir', id, '-b', 'add,maximized_vert,maximized_horz'], options(signal));
    }
  };
  return {
    async status(signal = AbortSignal.timeout(6000)) {
      try {
        const id = await find('chrome', signal); const window = id ? await owned(id, 'chrome', signal) : null;
        return { available: true, chrome: { present: !!window, minimized: !!window?.minimized } };
      } catch (error) {
        console.warn('Native browser status unavailable:', error instanceof Error ? error.name : 'UnknownError');
        return { available: false, chrome: { present: false, minimized: false } };
      }
    },
    async control(value) {
      const { action } = parseBrowserControl(value);
      const signal = AbortSignal.timeout(6000);
      if (action === 'restore-chrome') {
        const id = await find('chrome', signal); if (!id) throw new Error('Native browser unavailable');
        await restore(id, 'chrome', signal);
      } else if (action === 'show-desktop') await execute('/usr/bin/wmctrl', ['-k', 'on'], options(signal));
      else {
        const app = action === 'open-files' ? 'files' : 'terminal';
        const id = await find(app, signal);
        if (id) await restore(id, app, signal);
        else if (Date.now() >= launchCooldown[app]) {
          launchCooldown[app] = Date.now() + 5000;
          try {
            await execute('/usr/bin/wmctrl', ['-k', 'off'], options(signal));
            await launch(app === 'files' ? '/usr/bin/thunar' : '/usr/bin/xfce4-terminal', app === 'files' ? [matrixHome] : ['--disable-server', `--working-directory=${matrixHome}`], { ...options(signal), cwd: matrixHome });
          }
          catch (error) { launchCooldown[app] = 0; throw error; }
        }
      }
      return this.status(signal);
    },
  };
}
