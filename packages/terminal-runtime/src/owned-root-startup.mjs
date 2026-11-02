// Uncalled keeper-local primitive. Completion is bytes only, never source authority.
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isMainThread } from 'node:worker_threads';
import { encodePreparation, decodePreparedReply, encodeBootstrap, encodeTarget, decodeBootstrapAck } from './owned-root-wire.mjs';
import { createChildren, unavailable } from './owned-root-children.mjs';
const now = () => process.hrtime.bigint();
const names = ['controlPair', 'controlChildFd', 'receive', 'send', 'close', 'retainChild', 'childAlive', 'controlSendChildBirth'];
function path(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) throw unavailable();
  return value;
}
function copyEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const map = Object.create(null), entries = Object.entries(value);
  for (const [key, entry] of entries) {
    if (!key || key.includes('=') || key.includes('\0') || typeof entry !== 'string' || entry.includes('\0')
      || Buffer.from(key).toString('utf8') !== key || Buffer.from(entry).toString('utf8') !== entry) throw unavailable();
    map[key] = entry;
  }
  return Object.freeze(map);
}
export function createOwnedRootStartup(options) {
  if (!options || typeof options !== 'object') throw unavailable();
  const native = Object.create(null);
  for (const name of names) {
    if (typeof options.native?.[name] !== 'function') throw unavailable();
    native[name] = options.native[name].bind(options.native);
  }
  for (const name of ['validateInitialExec', 'validateDaemonExec', 'onOwnedChild']) if (typeof options[name] !== 'function') throw unavailable();
  const validateInitialExec = options.validateInitialExec, validateDaemonExec = options.validateDaemonExec;
  const initial = Object.freeze({ executable: path(options.executable), cwd: path(options.cwd), environment: copyEnvironment(options.environment) });
  if (!Buffer.isBuffer(options.generation) || options.generation.length !== 32) throw unavailable();
  const fields = { deadlineNs: options.deadlineNs, generation: Buffer.from(options.generation ?? []), nonce: randomBytes(32),
    sessionName: options.sessionName, layoutPath: path(options.layoutPath), socketPath: path(options.socketPath) };
  // Pure admission validates all fixed bytes before any native resource/effect.
  const preparation = encodePreparation(fields), bootstrap = encodeBootstrap(fields), target = encodeTarget(fields);
  if (typeof fields.deadlineNs !== 'bigint' || fields.deadlineNs - now() > 5_000_000_000n) throw unavailable();
  if (process.platform !== 'linux' || !isMainThread || typeof process.getuid !== 'function' || process.getuid() === 0) throw unavailable();
  let fenced = false, possibleHandoff = false, promise, resolve, result, timer;
  const children = createChildren(native, options.onOwnedChild, fence);
  function settle(disposition) {
    if (result) return;
    result = Object.freeze({ disposition }); clearTimeout(timer);
    resolve?.(result);
  }
  function fence() {
    fenced = true; children.closeControls();
    if (promise) settle(possibleHandoff ? 'unknown' : 'unsent');
  }
  function check() {
    if (fenced || now() >= fields.deadlineNs) throw unavailable();
  }
  function current(slot) {
    check();
    if (!slot?.pair || !children.alive(slot)) throw unavailable();
  }
  async function tick() { await new Promise(done => setTimeout(done, 1)); check(); }
  function empty(slot) {
    current(slot);
    const extra = native.receive(slot.pair.channel);
    if (extra !== null) {
      if (Buffer.isBuffer(extra?.data)) extra.data.fill(0);
      throw unavailable();
    }
    current(slot);
  }
  async function write(slot, bytes, birthSlot) {
    let offset = 0, sentBirth = false;
    while (offset < bytes.length) {
      current(slot);
      if (birthSlot) current(birthSlot);
      const part = bytes.subarray(offset, Math.min(offset + 8192, bytes.length));
      let written;
      if (birthSlot && !sentBirth) {
        // Even an error/zero leaves conservative possible effects latched.
        possibleHandoff = true;
        written = native.controlSendChildBirth(slot.pair.channel, part, birthSlot.birth);
      } else written = native.send(slot.pair.channel, part);
      if (!Number.isInteger(written) || written < 0 || written > part.length) throw unavailable();
      if (written > 0) { offset += written; if (birthSlot) sentBirth = true; }
      check();
      if (birthSlot) current(birthSlot);
      if (offset < bytes.length) await tick();
    }
  }
  async function readFrame(slot, max, decode) {
    const storage = Buffer.alloc(max);
    let offset = 0, expected;
    try {
      while (expected === undefined || offset < expected) {
        current(slot);
        const chunk = native.receive(slot.pair.channel);
        if (chunk === null) { await tick(); continue; }
        if (chunk === false || !Buffer.isBuffer(chunk?.data)) throw unavailable();
        const bytes = chunk.data;
        try {
          if (!bytes.length || bytes.length > 8192 || !chunk.writer || chunk.writer.pid !== slot.child.pid
            || chunk.writer.uid !== slot.pair.uid || chunk.writer.gid !== slot.pair.gid) throw unavailable();
          current(slot);
          if (offset + bytes.length > max) throw unavailable();
          bytes.copy(storage, offset); offset += bytes.length;
          if (offset >= 16 && expected === undefined) {
            expected = 16 + storage.readUInt32LE(12);
            if (expected < 16 || expected > max) throw unavailable();
          }
          if (expected !== undefined && offset > expected) throw unavailable();
          current(slot);
        } finally { bytes.fill(0); }
      }
      const decoded = decode(storage.subarray(0, expected));
      empty(slot); return decoded;
    } finally { storage.fill(0); }
  }
  async function run() {
    check();
    await validateInitialExec(initial); check();
    const initializer = children.launch('initializer', initial); current(initializer);
    await write(initializer, preparation); current(initializer);
    const environment = Object.freeze(await readFrame(initializer, 65536, bytes => decodePreparedReply(bytes, fields)));
    current(initializer);
    const daemonInput = Object.freeze({ executable: initial.executable, cwd: initial.cwd, environment });
    await validateDaemonExec(daemonInput); current(initializer); empty(initializer); check();
    const daemon = children.launch('daemon', daemonInput); current(daemon); current(initializer);
    await write(daemon, bootstrap);
    await readFrame(daemon, 8192, bytes => decodeBootstrapAck(bytes, fields));
    // This observation is only IO data; I independently verifies D's genuine birth.
    while (true) {
      current(daemon); current(initializer);
      try {
        const stat = await lstat(fields.socketPath); current(daemon); current(initializer);
        if (!stat.isSocket()) throw unavailable();
        break;
      } catch (error) { if (error?.code !== 'ENOENT') throw unavailable(); }
      await tick();
    }
    empty(initializer); empty(daemon); current(daemon);
    await write(initializer, target, daemon); check();
    const completion = await initializer.wait; check();
    if (initializer.error || completion.signal !== null) throw unavailable();
    if (completion.code === 0) settle('first_frame_complete');
    else if (completion.code === 69) settle('unsent');
    else settle('unknown');
  }
  function start() {
    if (promise) return promise;
    promise = new Promise(done => { resolve = done; });
    if (fenced || now() >= fields.deadlineNs) { fence(); return promise; }
    const remaining = fields.deadlineNs - now();
    timer = setTimeout(fence, Math.max(1, Number((remaining + 999999n) / 1000000n)));
    run().catch(() => fence());
    return promise;
  }
  function observe() { return Object.freeze({ initializer: children.state('initializer'), daemon: children.state('daemon'), fenced }); }
  async function waitForExit(role, observationDeadlineNs) {
    if (!['initializer', 'daemon'].includes(role) || typeof observationDeadlineNs !== 'bigint') throw unavailable();
    const slot = children.slots[role];
    if (!slot?.wait || slot.error || slot.observerPending || observationDeadlineNs <= now()) throw unavailable();
    const duration = Number((observationDeadlineNs - now() + 999999n) / 1000000n);
    if (!Number.isSafeInteger(duration) || duration > 2147483647) throw unavailable();
    // Claim capacity synchronously; never append a reaction to the long-lived
    // child wait Promise. Only this one bounded poll timer exists for this role.
    slot.observerPending = true;
    try {
      while (true) {
        const remaining = observationDeadlineNs - now();
        if (slot.error || remaining <= 0n) throw unavailable();
        if (slot.settled) return slot.result;
        await new Promise(done => setTimeout(done, Math.min(10, Math.max(1, Number((remaining + 999999n) / 1000000n)))));
      }
    } finally { slot.observerPending = false; }
  }
  return Object.freeze({ start, fence, observe, waitForExit, disposeExited: children.disposeExited });
}
