import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Grant, Action, validateFrame } from './contracts.mjs';

/** Manually authorized synthetic-target session; NOT production owner authentication. */
export function createQualificationSession({ grant: raw, backend, platform = process.platform, now = Date.now }) {
  const grant = Grant.parse(raw);
  return createValidatedQualificationSession({ grant, backend, platform, now });
}

/** @internal Trusted factories must validate the complete target policy before calling. */
export function createValidatedQualificationSession({ grant, backend, platform = process.platform, now = Date.now }) {
  if (platform !== 'linux' || grant.expiresAt <= now() || grant.expiresAt > now() + 600_000) throw new Error('qualification_unavailable');
  let observation, controller, running, stopped = false, epoch = 1, revision = 1, presenceAt = now();
  let geometry;
  const heldKeys = new Set(); // <=8, released after each action and stop.
  const heldButtons = new Set(); // <=1, released after each action and stop.
  const usedIds = new Set(); // <=256; reaching cap closes admission until a new grant.
  const eligible = () => !stopped && grant.expiresAt > now() && now() - presenceAt < 5000;
  async function release() {
    const releases = [
      ...[...heldKeys].reverse().map(key => ({ args: ['keyup', key], done: () => heldKeys.delete(key) })),
      ...[...heldButtons].map(button => ({ args: ['mouseup', String(button)], done: () => heldButtons.delete(button) })),
    ];
    const results = await Promise.allSettled(releases.map(async item => {
      await backend.command(item.args, AbortSignal.timeout(500)); item.done();
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      console.warn('[computer-qualification] input_release_failed', failure.reason instanceof Error ? failure.reason.name : 'UnknownError');
      stopped = true; throw new Error('cleanup_failed');
    }
  }
  async function stop() {
    stopped = true; epoch++; observation = undefined; controller?.abort();
    await running?.catch(error => { if (!(error instanceof Error)) console.warn('[computer-qualification] unknown_action_failure'); });
    await release();
  }
  const timer = setInterval(() => {
    if (!eligible()) { clearInterval(timer); void stop().catch(error => console.warn('[computer-qualification] cleanup_failed', error instanceof Error ? error.name : 'UnknownError')); }
  }, 100);
  timer.unref();
  async function observe(signal) {
    const frame = validateFrame(await backend.capture(signal));
    signal.throwIfAborted();
    if (!eligible()) throw new Error('qualification_unavailable');
    const nextGeometry = `${frame.width}x${frame.height}`;
    if (geometry && geometry !== nextGeometry) revision++;
    geometry = nextGeometry;
    observation = { observationId: randomUUID(), width: frame.width, height: frame.height, capturedAt: now(), geometryRevision: revision, leaseEpoch: epoch, origin: { x: 0, y: 0 }, scale: 1 };
    return { ...observation, data: frame.data };
  }
  async function mutate(input, signal) {
    const frame = observation;
    if (!frame || input.observationId !== frame.observationId || input.leaseEpoch !== epoch || input.geometryRevision !== revision || now() - frame.capturedAt > 5000) throw new Error('observe_again');
    if (usedIds.has(input.actionId) || usedIds.size >= 256) throw new Error('action_not_admitted');
    // Geometry is read from X11 immediately before input; capture cache alone is insufficient.
    const size = await backend.geometry(signal);
    if (size.width !== frame.width || size.height !== frame.height) { observation = undefined; revision++; throw new Error('observe_again'); }
    const points = input.action === 'drag' ? input.points : 'x' in input ? [input] : [];
    if (points.some(p => p.x >= frame.width || p.y >= frame.height)) throw new Error('invalid_action');
    if (!eligible()) throw new Error('qualification_unavailable');
    observation = undefined; usedIds.add(input.actionId);
    const command = args => backend.command(args, signal);
    const press = async keys => { for (const key of keys) { heldKeys.add(key); await command(['keydown', key]); } };
    const move = p => command(['mousemove', '--sync', String(p.x), String(p.y)]);
    try {
      if (input.action === 'click') {
        await move(input); heldButtons.add(1); await command(['mousedown', '1']);
      } else if (input.action === 'drag') {
        await move(input.points[0]); heldButtons.add(1); await command(['mousedown', '1']);
        for (const point of input.points.slice(1)) {
          let remaining = input.durationMs / (input.points.length - 1);
          while (remaining > 0) { const part = Math.min(remaining, 250); await delay(part, undefined, { signal }); remaining -= part; }
          await move(point);
        }
      } else if (input.action === 'scroll') {
        await move(input);
        for (let i = 0; i < input.ticks; i++) {
          const button = input.direction === 'up' ? 4 : 5;
          heldButtons.add(button); await command(['mousedown', String(button)]); await release();
        }
      } else if (input.action === 'type') {
        // Avoid a killed xdotool type process leaving an unknown internally-generated key held.
        for (const character of input.text) {
          await press(asciiKeys(character)); await release();
        }
      } else if (input.action === 'key') {
        if (new Set(input.keys).size !== input.keys.length) throw new Error('invalid_action');
        await press(input.keys);
      }
    } finally { await release(); }
    signal.throwIfAborted();
    return observe(signal);
  }
  async function execute(raw, signal) {
    const input = Action.parse(raw);
    if (!eligible()) throw new Error('qualification_unavailable');
    if (running) throw new Error('qualification_busy');
    const actionController = new AbortController(); controller = actionController;
    const abort = () => actionController.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const actionSignal = AbortSignal.any([actionController.signal, AbortSignal.timeout(5000)]);
    running = (async () => {
      actionSignal.throwIfAborted();
      if (input.action === 'status') return { active: true, leaseEpoch: epoch, syntheticOnly: true };
      return input.action === 'observe' ? observe(actionSignal) : mutate(input, actionSignal);
    })();
    try { return await running; }
    catch (error) { observation = undefined; throw error; }
    finally { signal?.removeEventListener('abort', abort); running = undefined; controller = undefined; }
  }
  return {
    execute,
    // Trusted operator control only. Never expose presence/stop as model tool actions.
    presence() { if (!eligible()) throw new Error('qualification_unavailable'); presenceAt = now(); },
    async stop() { clearInterval(timer); await stop(); },
  };
}

// Explicit US-ASCII test layout only; IME/other layouts require real qualification.
const BASE = { ' ':'SPACE', '-':'MINUS', '=':'EQUAL', '[':'BRACKETLEFT', ']':'BRACKETRIGHT',
  '\\':'BACKSLASH', ';':'SEMICOLON', "'":'APOSTROPHE', ',':'COMMA', '.':'PERIOD', '/':'SLASH', '`':'GRAVE' };
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
const UNSHIFTED = "`1234567890-=[]\\;',./";
function asciiKeys(character) {
  const index = SHIFTED.indexOf(character), base = index < 0 ? character : UNSHIFTED[index];
  const key = BASE[base] ?? base.toUpperCase();
  return index >= 0 || /^[A-Z]$/.test(character) ? ['SHIFT', key] : [key];
}
