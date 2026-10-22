import { describe, expect, it, vi } from 'vitest';
import { attachViewerBridge, injectViewerBridge, VIEWER_BRIDGE_SCRIPT } from '../../packages/gateway/src/browser-lab/viewer-bridge.js';

function rig(connected = false, targetOrigin?: string, withoutRfb = false) {
  let mutation!: () => void;
  const postMessage = vi.fn();
  const host = Object.assign(new EventTarget(), { parent: { postMessage }, location: { origin: 'https://gateway.matrix.test' } });
  const page = { documentElement: { classList: { contains: () => connected } } };
  const disconnect = vi.fn();
  const Observer = class { constructor(callback: () => void) { mutation = callback; } observe() {} disconnect = disconnect; };
  const ui = { rfb: withoutRfb ? undefined : new EventTarget() };
  const dispose = attachViewerBridge(ui, { window: host, document: page, MutationObserver: Observer, targetOrigin });
  return { ui, dispose, mutation: () => mutation(), setConnected: (value: boolean) => { connected = value; mutation(); }, postMessage, disconnect, host };
}
describe('pinned viewer connectivity-only bridge', () => {
  it('uses the bundled client connected class even without an accessible RFB singleton', () => {
    const { postMessage, setConnected, host, disconnect } = rig(true, undefined, true);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'matrix-browser-viewer', connected: true }, 'https://gateway.matrix.test');
    setConnected(false); setConnected(false); setConnected(true);
    expect(postMessage.mock.calls.map(call => call[0].connected)).toEqual([true, false, true]);
    host.dispatchEvent(new Event('pagehide'));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls.map(call => call[0].connected)).toEqual([true, false, true, false]);
    setConnected(true); expect(postMessage).toHaveBeenCalledTimes(4);
  });
  it('executes the self-contained installed script without importing a second viewer UI', () => {
    expect(VIEWER_BRIDGE_SCRIPT).not.toMatch(/\bimport\b|app\/ui\.js/);
    let mutation!: () => void; let connected = true;
    const postMessage = vi.fn();
    const host = Object.assign(new EventTarget(), { parent: { postMessage }, location: { origin: 'https://gateway.matrix.test' } });
    const page = { documentElement: { classList: { contains: (name: string) => name === 'noVNC_connected' && connected } } };
    const disconnect = vi.fn();
    const Observer = class { constructor(callback: () => void) { mutation = callback; } observe() {} disconnect = disconnect; };
    new Function('window', 'document', 'MutationObserver', VIEWER_BRIDGE_SCRIPT)(host, page, Observer);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'matrix-browser-viewer', connected: true }, 'https://gateway.matrix.test');
    connected = false; mutation();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'matrix-browser-viewer', connected: false }, 'https://gateway.matrix.test');
    host.dispatchEvent(new Event('pagehide')); expect(disconnect).toHaveBeenCalledOnce();
  });
  it('reports native connect/disconnect and tears down all observers on pagehide', () => {
    const { ui, postMessage, host, disconnect } = rig();
    ui.rfb.dispatchEvent(new Event('connect'));
    ui.rfb.dispatchEvent(new Event('disconnect'));
    expect(postMessage.mock.calls.map(call => call[0])).toEqual([
      { type: 'matrix-browser-viewer', connected: false }, { type: 'matrix-browser-viewer', connected: true }, { type: 'matrix-browser-viewer', connected: false },
    ]);
    host.dispatchEvent(new Event('pagehide'));
    ui.rfb.dispatchEvent(new Event('connect'));
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it('handles already-connected clients without exposing streamed page data', () => {
    const { postMessage, dispose } = rig(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'matrix-browser-viewer', connected: true }, 'https://gateway.matrix.test');
    expect(VIEWER_BRIDGE_SCRIPT).not.toMatch(/clipboard|screenshot|credentials|title|innerHTML/);
    dispose();
  });
  it('supports an explicitly validated separate parent origin without wildcard messages', () => {
    const { postMessage, dispose } = rig(false, 'http://localhost:3000');
    expect(postMessage.mock.calls[0][1]).toBe('http://localhost:3000');
    expect(() => rig(false, 'https://attacker.test/path')).toThrow();
    dispose();
  });
  it('injects a scoped module only into bounded viewer HTML', () => {
    expect(injectViewerBridge('<html><body>viewer</body></html>', 'http://localhost:3000')).toContain('matrix-viewer-bridge.mjs');
    expect(injectViewerBridge('<html><body>viewer</body></html>', 'http://localhost:3000')).toContain('matrix-parent-origin');
    expect(() => injectViewerBridge('not html')).toThrow();
    expect(() => injectViewerBridge('x'.repeat(500_001))).toThrow();
  });
});
