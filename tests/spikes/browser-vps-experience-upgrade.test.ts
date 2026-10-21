import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderNativeExperience } from '../../scripts/spikes/browser-vps/native-experience-units.mjs';
describe('profile-preserving native experience upgrade', () => {
  it('starts future Chrome maximized with prior session and bounded normal-exit recovery', () => {
    const files = renderNativeExperience(); const chrome = files['matrix-browser-lab-chrome.service'];
    expect(chrome).toContain('--start-maximized --restore-last-session chrome://newtab');
    expect(chrome).not.toContain('/fixture'); expect(chrome).toContain('Restart=always');
    expect(chrome).toContain('StartLimitBurst=5'); expect(chrome).toContain('chrome-graceful-stop.mjs ${MAINPID}');
    expect(chrome).toContain('User=matrix');
  });
  it('adds fixed desktop/panel services and icon-only recovery without private titles', () => {
    const files = renderNativeExperience(); expect(Object.keys(files)).toHaveLength(4);
    expect(files['matrix-browser-lab-desktop.service']).toContain('/usr/bin/xfdesktop');
    expect(files['matrix-browser-lab-panel.service']).toContain('/usr/bin/tint2');
    expect(files['tint2rc']).toContain('task_text = 0'); expect(files['tint2rc']).toContain('task_tooltip = 0');
  });
  it('guards the exact preview and never reinstalls or restarts Chrome/VNC in an upgrade', async () => {
    const script = await readFile(new URL('../../scripts/spikes/browser-vps/update-experience.sh', import.meta.url), 'utf8');
    expect(script).toContain('/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" guard "$1"');
    expect(script).toContain('/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" install "$1"');
    expect(script).not.toContain('LAB_NODE'); expect(script).not.toContain('/opt/matrix/runtime/node');
    expect(script.indexOf('native-experience.py" guard')).toBeLessThan(script.indexOf('apt-get update'));
    expect(script.indexOf('native-experience.py" guard')).toBeLessThan(script.indexOf('tar -C'));
    expect(script).toContain('systemctl restart matrix-browser-lab.service');
    expect(script).not.toMatch(/systemctl (?:restart|stop|start|enable).*matrix-browser-lab-(?:chrome|vnc)/);
    expect(script).not.toMatch(/\bpip\b|google-chrome-stable_current|kasmvncserver|agent-browser-linux/);
    expect(script).not.toMatch(/chromeProfile|rm .*chrome|\/home\/matrix\/\.local\/share/);
  });
  it('uses isolated system Python for newly shared privileged installer steps', async () => {
    const script = await readFile(new URL('../../scripts/spikes/browser-vps/install.sh', import.meta.url), 'utf8');
    expect(script).toContain('/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" guard "$1"');
    expect(script).toContain('/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" install "$1"');
    expect(script).not.toMatch(/"\$LAB_NODE" "\$LAB_SOURCE\/(?:target-guard|native-experience-units)\.mjs"/);
  });
});
