// Transport only: endpoint schemas/authorization live in the parser and owning host.
// No handles, environment hints, credentials in logs, retries or shared daemon sockets.
export function attachRoutineIpcRelay(parent, child) {
  if (typeof parent.send !== 'function' || !parent.connected || !child.connected) throw new Error('Private IPC unavailable');
  let closed = false, upstream = 0, downstream = 0, pendingUp = 0, pendingDown = 0, killTimer;
  function valid(value) {
    try {
      const json = JSON.stringify(value);
      if (!json || Buffer.byteLength(json) > 32768 || !value || typeof value !== 'object' || Array.isArray(value)) return false;
      let depth = 0, quoted = false, escaped = false;
      for (const char of json) {
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') { if (++depth > 16) return false; }
        else if (char === '}' || char === ']') depth--;
      }
      return true;
    } catch (error) {
      console.warn("[routine-cli-relay] Frame invalid", error instanceof Error ? error.name : "UnknownError"); return false;
    }
  }
  function cleanup() {
    if (closed) return; closed = true;
    parent.removeListener('message', toChild); parent.removeListener('disconnect', parentGone);
    parent.removeListener('SIGINT', terminate); parent.removeListener('SIGTERM', terminate);
    child.removeListener('message', toParent); child.removeListener('disconnect', childGone); child.removeListener('close', ended);
  }
  function terminate() {
    cleanup();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref();
      child.once('close', () => clearTimeout(killTimer));
    }
  }
  function parentGone() { terminate(); }
  function childGone() { cleanup(); if (parent.connected) parent.disconnect(); }
  function ended() { cleanup(); clearTimeout(killTimer); if (parent.connected) parent.disconnect(); }
  function toChild(value, handle) {
    if (closed) return;
    if (handle || !valid(value) || ++downstream > 4 || ++pendingDown > 2 || !child.connected) { terminate(); return; }
    child.send(value, error => { pendingDown--; if (error) terminate(); }); // false means queued/backpressured, never resend.
  }
  function toParent(value, handle) {
    if (closed) return;
    if (handle || !valid(value) || ++upstream > 4 || ++pendingUp > 2 || !parent.connected) { terminate(); return; }
    parent.send(value, error => { pendingUp--; if (error) terminate(); });
  }
  parent.on('message', toChild); parent.once('disconnect', parentGone);
  parent.once('SIGINT', terminate); parent.once('SIGTERM', terminate);
  child.on('message', toParent); child.once('disconnect', childGone); child.once('close', ended);
  return { close: terminate };
}
