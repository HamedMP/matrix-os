// Internal actual-child ownership. No borrowed view exposes a native handle.
import { spawn } from 'node:child_process';
export const unavailable = () => new Error('owned Root unavailable');
export function createChildren(native, onOwnedChild, fence) {
  const slots = { initializer: null, daemon: null };
  function alive(slot) {
    if (!slot || !slot.birth || slot.disposed) throw unavailable();
    return native.childAlive(slot.birth);
  }
  function launch(role, options) {
    const pair = native.controlPair();
    const slot = { pair, child: null, birth: null, disposed: false, settled: false, error: false };
    slots[role] = slot;
    let childEndClosed = false;
    try {
      const fd = native.controlChildFd(pair.child);
      const child = spawn(options.executable, [role === 'initializer' ? '--matrix-private-initializer' : '--matrix-private-server', '3'],
        { cwd: options.cwd, env: options.environment, stdio: ['ignore', 'pipe', 'pipe', fd] });
      slot.child = child;
      slot.wait = new Promise(resolve => {
        child.once('error', () => { slot.error = true; fence(); });
        child.once('close', (code, signal) => { slot.settled = true; slot.result = Object.freeze({ code, signal }); resolve(slot.result); });
      });
      // Retain synchronously from this actual spawn return before readers/callback/await.
      try { slot.birth = native.retainChild(child.pid); } catch { slot.retentionFailed = true; }
      // Drop the parent's inherited child endpoint before any reader/owner handoff.
      // A close failure still cannot skip the once-only actual-child callback.
      try { native.close(pair.child); childEndClosed = true; } catch { slot.closeFailed = true; fence(); }
      let stderrBytes = 0;
      child.stdout.on('data', () => fence());
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) fence(); });
      const view = Object.freeze({ alive: () => alive(slot) });
      const returned = onOwnedChild(role, child, view);
      if (returned && typeof returned.then === 'function') {
        Promise.resolve(returned).catch(() => fence());
        throw unavailable();
      }
      if (!slot.birth || slot.error || slot.closeFailed) throw unavailable();
      return slot;
    } catch (error) {
      // A returned child remains in slots, with its wait observer and birth.
      fence(); throw unavailable();
    } finally {
      if (!childEndClosed) {
        try { native.close(pair.child); } catch { slot.closeFailed = true; }
      }
    }
  }
  function closeControls() {
    for (const slot of Object.values(slots)) if (slot?.pair) {
      try { native.close(slot.pair.channel); } catch { slot.error = true; }
      try { native.close(slot.pair.child); } catch { slot.error = true; }
      slot.pair = null;
    }
  }
  function state(role) {
    const slot = slots[role];
    if (!slot?.child) return slot ? 'unknown' : 'not-spawned';
    if (slot.settled) return slot.error ? 'unknown' : 'exited';
    try { return !slot.error && alive(slot) ? 'running' : 'unknown'; } catch { return 'unknown'; }
  }
  function disposeExited() {
    for (const slot of Object.values(slots)) {
      if (!slot?.settled || slot.disposed) continue;
      if (slot.birth) {
        if (native.childAlive(slot.birth)) continue;
        native.close(slot.birth); slot.birth = null;
      }
      if (slot.pair) {
        native.close(slot.pair.channel); native.close(slot.pair.child); slot.pair = null;
      }
      slot.disposed = true;
    }
  }
  return { slots, launch, alive, closeControls, state, disposeExited };
}
