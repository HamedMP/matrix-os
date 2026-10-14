import { describe, expect, it, vi } from 'vitest';
import { createNativeWindows, launchNativeApp, parseWindowProperties } from '../../scripts/spikes/browser-vps/native-windows.mjs';

const props = 'WM_CLASS(STRING) = "google-chrome", "Google-chrome"\n_NET_WM_PID(CARDINAL) = 123\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL';
function rig(overrides: any = {}) {
  const execute = vi.fn(async (_file: string, args: string[]) => ({ stdout: args.includes('-root') ? '_NET_CLIENT_LIST(WINDOW): window id # 0xabc' : props, stderr: '' }));
  const inspectProcess = vi.fn(async () => ({ uid: 1000, exe: '/opt/google/chrome/chrome', arguments: ['chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome'], cgroup: '0::/system.slice/matrix-browser-lab-chrome.service' }));
  const launch = vi.fn(async () => undefined);
  const service = createNativeWindows({ execute, launch, inspectProcess, ownerUid: 1000, ...overrides });
  return { service, execute, inspectProcess, launch };
}
describe('owner-only native browser windows', () => {
  it.each([
    '/opt/google/chrome/chrome --no-first-run --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome --start-maximized chrome://newtab',
    '/opt/google/chrome/chrome --no-first-run --user-data-dir /home/matrix/.local/share/matrix-browser-lab/chrome --start-maximized chrome://newtab',
  ])('recognizes a bounded collapsed Chrome process title with the exact single profile (%#)', async title => {
    const { service, inspectProcess } = rig();
    inspectProcess.mockResolvedValue({ uid: 1000, exe: '/opt/google/chrome/chrome', arguments: [title], cgroup: '0::/system.slice/matrix-browser-lab-chrome.service' });
    expect((await service.status()).chrome.present).toBe(true);
    await expect(service.control({ action: 'restore-chrome' })).resolves.toMatchObject({ chrome: { present: true } });
  });
  it.each([
    '/tmp/chrome --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome',
    'chrome --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome',
    '/opt/google/chrome/chrome-other --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome',
    '/opt/google/chrome/chrome --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrom',
    '/opt/google/chrome/chrome --user-data-dir=',
    '/opt/google/chrome/chrome --user-data-dir',
    '/opt/google/chrome/chrome --user-data-dir=/tmp/other',
    '/opt/google/chrome/chrome --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome --user-data-dir=/tmp/other',
    '/opt/google/chrome/chrome --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome --user-data-dir /home/matrix/.local/share/matrix-browser-lab/chrome',
    '/opt/google/chrome/chrome --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome --user-data-dir',
    '/opt/google/chrome/chrome\n--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome',
    '/opt/google/chrome/chrome --user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome ' + 'x'.repeat(4096),
  ])('rejects untrusted, conflicting, truncated or unbounded collapsed titles (%#)', async title => {
    const { service, inspectProcess, execute } = rig();
    inspectProcess.mockResolvedValue({ uid: 1000, exe: '/opt/google/chrome/chrome', arguments: [title], cgroup: '0::/system.slice/matrix-browser-lab-chrome.service' });
    expect((await service.status()).chrome.present).toBe(false);
    await expect(service.control({ action: 'restore-chrome' })).rejects.toThrow();
    expect(execute.mock.calls.some(call => call[0] === '/usr/bin/wmctrl')).toBe(false);
  });
  it.each([
    ['chrome', '--user-data-dir', '/home/matrix/.local/share/matrix-browser-lab/chrome'],
    ['chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome'],
  ])('recognizes and restores the observed fixed-profile Chrome WM_CLASS with %j', async (...argv) => {
    const profileClass = 'google-chrome (/home/matrix/.local/share/matrix-browser-lab/chrome)';
    const metadata = props.replace('"google-chrome"', `"${profileClass}"`);
    const { service, execute, inspectProcess, launch } = rig();
    execute.mockImplementation(async (_file, args) => ({ stdout: args.includes('-root') ? '_NET_CLIENT_LIST(WINDOW): window id # 0xabc' : metadata, stderr: '' }));
    inspectProcess.mockResolvedValue({ uid: 1000, exe: '/opt/google/chrome/chrome', arguments: argv, cgroup: '0::/system.slice/matrix-browser-lab-chrome.service' });
    expect(parseWindowProperties(metadata).instance).toBe(profileClass);
    expect((await service.status()).chrome).toEqual({ present: true, minimized: true });
    await service.control({ action: 'restore-chrome' });
    expect(execute).toHaveBeenCalledWith('/usr/bin/wmctrl', ['-ia', '0xabc'], expect.any(Object));
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([
    'google-chrome (/tmp/other-profile)',
    'google-chrome (/home/matrix/.local/share/matrix-browser-lab/Chrome)',
    'google-chrome (/home/matrix/.local/share/matrix-browser-lab/chrome) extra',
  ])('rejects a profile class alias outside the exact fixed profile (%s)', async alias => {
    const { service, execute } = rig();
    execute.mockImplementation(async (_file, args) => ({ stdout: args.includes('-root') ? '_NET_CLIENT_LIST(WINDOW): window id # 0xabc' : props.replace('"google-chrome"', `"${alias}"`), stderr: '' }));
    expect((await service.status()).chrome.present).toBe(false);
    await expect(service.control({ action: 'restore-chrome' })).rejects.toThrow();
    expect(execute.mock.calls.some(call => call[0] === '/usr/bin/wmctrl')).toBe(false);
  });
  it.each([
    ['chrome', '--user-data-dir', '/tmp/other'],
    ['chrome', '--user-data-dir'],
    ['chrome'],
    ['chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome', '--user-data-dir=/tmp/other'],
    ['chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome'],
    ['chrome', '--user-data-dir', '/home/matrix/.local/share/matrix-browser-lab/chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome'],
    ['chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome', '--user-data-dir'],
  ])('rejects absent, conflicting or duplicated profile switches (%j)', async (...argv) => {
    const { service, inspectProcess, execute } = rig();
    inspectProcess.mockResolvedValue({ uid: 1000, exe: '/opt/google/chrome/chrome', arguments: argv, cgroup: '0::/system.slice/matrix-browser-lab-chrome.service' });
    expect((await service.status()).chrome.present).toBe(false);
    await expect(service.control({ action: 'restore-chrome' })).rejects.toThrow();
    expect(execute.mock.calls.some(call => call[0] === '/usr/bin/wmctrl')).toBe(false);
  });
  it('parses only fixed WM_CLASS/PID/state/type metadata', () => {
    expect(parseWindowProperties(props)).toEqual({ pid: 123, className: 'Google-chrome', instance: 'google-chrome', minimized: true, normal: true });
    expect(() => parseWindowProperties('WM_CLASS(STRING) = "bad"\n_NET_WM_PID(CARDINAL) = 0')).toThrow();
  });
  it('restores and maximizes the existing owned Chrome without a launch or restart', async () => {
    const { service, execute, launch } = rig();
    expect(await service.status()).toEqual({ available: true, chrome: { present: true, minimized: true } });
    await service.control({ action: 'restore-chrome' });
    expect(execute).toHaveBeenCalledWith('/usr/bin/wmctrl', ['-ia', '0xabc'], expect.any(Object));
    expect(execute).toHaveBeenCalledWith('/usr/bin/wmctrl', ['-ir', '0xabc', '-b', 'add,maximized_vert,maximized_horz'], expect.any(Object));
    expect(execute.mock.calls.every(call => !String(call).includes('restart'))).toBe(true);
    expect(execute.mock.calls.flatMap(call => call[1]).join(' ')).not.toMatch(/WM_NAME|wm_name|-l/);
  });
  it.each([
    { uid: 999 }, { exe: '/usr/bin/untrusted' }, { cgroup: '0::/user.slice/unrelated.service' },
    { arguments: ['chrome', '--user-data-dir=/tmp/other-profile'] },
  ])('rejects a foreign process or mismatched profile/service (%j)', async mismatch => {
    const { service, inspectProcess, execute } = rig();
    inspectProcess.mockResolvedValue({ uid: 1000, exe: '/opt/google/chrome/chrome', arguments: ['chrome', '--user-data-dir=/home/matrix/.local/share/matrix-browser-lab/chrome'], cgroup: '0::/system.slice/matrix-browser-lab-chrome.service', ...mismatch });
    expect((await service.status()).chrome.present).toBe(false);
    await expect(service.control({ action: 'restore-chrome' })).rejects.toThrow();
    expect(execute.mock.calls.some(call => call[0] === '/usr/bin/wmctrl')).toBe(false);
  });
  it('rejects missing Chrome safely, bounds commands, and reports only coarse availability', async () => {
    const { service, execute } = rig(); execute.mockRejectedValue(new Error('/private/profile/provider sensitive failure'));
    expect(await service.status()).toEqual({ available: false, chrome: { present: false, minimized: false } });
    await expect(service.control({ action: 'restore-chrome' })).rejects.toThrow();
    expect(execute.mock.calls[0][2]).toMatchObject({ timeout: 3000, maxBuffer: 16384 });
  });
  it('uses fixed desktop/files/terminal actions and rejects extra user input', async () => {
    const { service, execute, launch } = rig();
    await service.control({ action: 'show-desktop' });
    await service.control({ action: 'open-files' });
    await service.control({ action: 'open-terminal' });
    expect(execute).toHaveBeenCalledWith('/usr/bin/wmctrl', ['-k', 'on'], expect.any(Object));
    expect(launch).toHaveBeenCalledWith('/usr/bin/thunar', ['/home/matrix/home'], expect.objectContaining({ cwd: '/home/matrix/home' }));
    expect(launch).toHaveBeenCalledWith('/usr/bin/xfce4-terminal', ['--disable-server', '--working-directory=/home/matrix/home'], expect.objectContaining({ cwd: '/home/matrix/home' }));
    await expect(service.control({ action: 'open-files', path: '/private' })).rejects.toThrow();
  });
  it.each(['open-files', 'open-terminal'])('leaves Show desktop before first launch of %s, with bounded fixed home options', async action => {
    const { service, execute, launch } = rig();
    await service.control({ action });
    const reveal = execute.mock.calls.findIndex(call => call[0] === '/usr/bin/wmctrl' && call[1].join(' ') === '-k off');
    expect(reveal).toBeGreaterThanOrEqual(0);
    expect(execute.mock.invocationCallOrder[reveal]).toBeLessThan(launch.mock.invocationCallOrder[0]);
    expect(launch.mock.calls[0][2]).toMatchObject({ cwd: '/home/matrix/home', timeout: 3000, maxBuffer: 16384 });
    expect(launch.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
    await service.control({ action });
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('does not launch if leaving Show desktop fails, and allows a subsequent retry', async () => {
    const { service, execute, launch } = rig();
    const normalExecute = execute.getMockImplementation()!;
    execute.mockImplementation(async (file, args) => {
      if (file === '/usr/bin/wmctrl') throw new Error('Unavailable desktop');
      return normalExecute(file, args);
    });
    await expect(service.control({ action: 'open-terminal' })).rejects.toThrow('Unavailable desktop');
    expect(launch).not.toHaveBeenCalled();
    execute.mockImplementation(normalExecute);
    await service.control({ action: 'open-terminal' });
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['open-files', 'thunar', 'Thunar', '/usr/bin/thunar'],
    ['open-terminal', 'xfce4-terminal', 'Xfce4-terminal', '/usr/bin/xfce4-terminal'],
  ])('restores the existing owner window for %s without resetting its working directory', async (action, instance, className, exe) => {
    const { service, execute, inspectProcess, launch } = rig();
    execute.mockImplementation(async (_file, args) => ({ stdout: args.includes('-root') ? '_NET_CLIENT_LIST(WINDOW): window id # 0xabc' : props.replace('"google-chrome", "Google-chrome"', `"${instance}", "${className}"`), stderr: '' }));
    inspectProcess.mockResolvedValue({ uid: 1000, exe, arguments: [], cgroup: '' });
    await service.control({ action });
    expect(execute).toHaveBeenCalledWith('/usr/bin/wmctrl', ['-ia', '0xabc'], expect.any(Object));
    expect(launch).not.toHaveBeenCalled();
    expect(inspectProcess).toHaveBeenCalledWith(123);
  });
  it.each([
    ['/usr/bin/thunar', ['/home/matrix/home'], 'matrix-browser-lab-files.service'],
    ['/usr/bin/xfce4-terminal', ['--disable-server', '--working-directory=/home/matrix/home'], 'matrix-browser-lab-terminal.service'],
  ])('launches %s in a fixed bounded owner service separate from supervisor lifetime', async (file, args, unit) => {
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const options = { cwd: '/home/matrix/home', signal: new AbortController().signal, env: { HOME: '/home/matrix', XDG_RUNTIME_DIR: '/run/user/996', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/996/bus', DISPLAY: ':7', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 3000, maxBuffer: 16384 };
    await launchNativeApp(file, args, options, execute);
    const [binary, parameters, actualOptions] = execute.mock.calls[0];
    expect(binary).toBe('/usr/bin/systemd-run');
    expect(parameters).toEqual(expect.arrayContaining(['--user', '--collect', '--no-block', `--unit=${unit}`, '--working-directory=/home/matrix/home', '--setenv=DISPLAY=:7', '--property=MemoryMax=512M', '--property=TasksMax=128', '--property=TimeoutStopSec=5s', '--property=NoNewPrivileges=yes']));
    expect(parameters.slice(parameters.indexOf('--') + 1)).toEqual([file, ...args]);
    expect(parameters).not.toContain('--scope'); expect(parameters).not.toContain('--property=PartOf=matrix-browser-lab.service');
    expect(actualOptions).toEqual(options);
    expect(actualOptions.env).not.toHaveProperty('NODE_OPTIONS');
  });
  it('rejects arbitrary launch commands and propagates owner-manager failure for retry', async () => {
    const execute = vi.fn(async () => { throw new Error('User manager unavailable'); });
    const options = { signal: new AbortController().signal, env: { XDG_RUNTIME_DIR: '/run/user/996', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/996/bus' }, cwd: '/home/matrix/home', timeout: 3000, maxBuffer: 16384 };
    await expect(launchNativeApp('/bin/sh', ['-c', 'anything'], options, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(launchNativeApp('/usr/bin/thunar', ['/home/matrix/home'], options, execute)).rejects.toThrow('User manager unavailable');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('derives the owner bus from the validated uid without inheriting caller bus or cwd', async () => {
    const { service, launch } = rig({ ownerUid: 996 });
    await service.control({ action: 'open-files' });
    expect(launch.mock.calls[0][2].env).toEqual({ HOME: '/home/matrix', PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: ':7', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: '/run/user/996', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/996/bus' });
    expect(() => createNativeWindows({ ownerUid: 0 })).toThrow();
  });
});
