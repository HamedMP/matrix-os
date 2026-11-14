import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { redact, withDevStackRegistryLock } from './local.mjs';
import { identifySourceWorktree, projectSource } from './source-projection.mjs';

const slug = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ownerId = /^user_[A-Za-z0-9_]{1,128}$/;
const machineId = /^[A-Za-z0-9_-]{1,128}$/;
const handle = /^[a-z0-9][a-z0-9-]{1,62}$/;
const digest = /^[a-f0-9]{64}$/;

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches = (pattern, value) => typeof value === 'string' && !value.includes('\n') && pattern.test(value);
const canonicalPath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const unavailable = () => new Error('Stage 3 source binding unavailable.');

function contains(parent, child) {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

export async function identifyStage3Target(path) {
  if (await realpath(path) !== path) throw unavailable();
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n)) throw unavailable();
  return hash([path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
}

export const identifyStage3Source = identifySourceWorktree;
export const isStage3Handle = value => matches(handle, value);

function validateBinding(binding) {
  if (!matches(ownerId, binding?.owner) || !matches(slug, binding.runtime) || !matches(slug, binding.worktree) ||
      !matches(digest, binding.generation) || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= 0 ||
      !matches(machineId, binding.source?.computerId) || !canonicalPath(binding.source.root) ||
      !matches(digest, binding.source.identity) || !isStage3Handle(binding.target?.handle) ||
      !canonicalPath(binding.target.root) || !matches(digest, binding.target.identity) ||
      !matches(digest, binding.target.containerId)) throw new Error('Invalid Stage 3 source enrollment.');
}

/**
 * A trusted receiver, owned by the isolated DevStack deployment. It must be
 * the sole writer to its managed targets, which the runtimes consume read-only.
 * authenticate verifies current operator membership, and readBinding observes
 * the current source checkout and registered runtime using server-side state.
 * Neither callback may accept caller-provided owner, paths, or attestations.
 * Bound transport and test timeouts belong to the injected implementations.
 */
export function createStage3SourceSync({ stateDir, bindings, authenticate, readBinding, testRevision, now = Date.now }) {
  if (!canonicalPath(stateDir) || !Array.isArray(bindings) || !bindings.length || bindings.length > 24 ||
      typeof authenticate !== 'function' || typeof readBinding !== 'function') {
    throw new Error('Invalid Stage 3 source registry configuration.');
  }
  const roots = [stateDir];
  const registered = new Map();
  const handles = new Set();
  const targets = new Set();
  for (const input of bindings) {
    validateBinding(input);
    const binding = Object.freeze({
      ...input, source: Object.freeze({ ...input.source }), target: Object.freeze({ ...input.target }),
    });
    for (const root of [binding.source.root, binding.target.root]) {
      if (roots.some(prior => contains(prior, root) || contains(root, prior))) {
        throw new Error('Stage 3 source and target directories must not overlap.');
      }
      roots.push(root);
    }
    if (registered.has(binding.runtime) || handles.has(binding.target.handle) || targets.has(binding.target.containerId)) {
      throw new Error('Duplicate Stage 3 source enrollment.');
    }
    registered.set(binding.runtime, binding);
    handles.add(binding.target.handle);
    targets.add(binding.target.containerId);
  }

  async function synchronize(credential, selection, onPublished) {
    if (!matches(slug, selection?.runtime) || !matches(slug, selection.worktree) ||
        !matches(digest, selection.generation)) throw unavailable();
    const actor = await authenticate(credential);
    const binding = registered.get(selection.runtime);
    if (!binding || actor !== binding.owner || selection.worktree !== binding.worktree || selection.generation !== binding.generation ||
        now() >= binding.expiresAt) throw unavailable();
    const { source, target } = binding;

    async function verify() {
      const active = await readBinding(binding);
      if (active?.generation !== binding.generation || active.source?.owner !== actor ||
          active.source.computerId !== source.computerId || active.source.identity !== source.identity ||
          active.target?.owner !== actor || active.target.handle !== target.handle ||
          active.target.containerId !== target.containerId || active.target.identity !== target.identity) throw unavailable();
      try {
        const [sourceIdentity, targetIdentity] = await Promise.all([
          identifyStage3Source(source.root), identifyStage3Target(target.root),
        ]);
        if (sourceIdentity !== source.identity || targetIdentity !== target.identity) throw unavailable();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw unavailable();
      }
      if (now() >= binding.expiresAt) throw unavailable();
    }

    async function verifySession() {
      if (await authenticate(credential) !== actor) throw unavailable();
      await verify();
    }

    const stateKey = hash([actor, source.computerId, source.identity, target.containerId, target.identity]);
    // Lock by destination path independently of generation so a replacement
    // enrollment cannot publish concurrently into the same checkout.
    const lock = hash(target.root) + '.lock';
    return withDevStackRegistryLock(stateDir, async () => {
      await verify();
      const result = await projectSource({
        worktree: source.root,
        destination: target.root,
        statePath: join(stateDir, stateKey + '.json'),
        beforePublish: verifySession,
        protectDestination: true,
      });
      // Internal paths are for the deployment, not the sync client.
      const receipt = { revision: result.revision, files: result.files, updated: result.updated, removed: result.removed };
      return onPublished ? onPublished(receipt, binding, verifySession) : receipt;
    }, lock);
  }

  async function testPublishedRevision(binding, revision, signal, verifySession) {
    // Hold the target lock through this call. Only the enrolled runner can
    // choose the test command.
    const { exitCode, log } = await testRevision(binding, revision, signal);
    await verifySession();
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || typeof log !== 'string') {
      throw new Error('Invalid Stage 3 source test result.');
    }
    const safeLog = redact(log.slice(0, 16 * 1024))
      .replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu, ' ').trim().slice(0, 4096);
    return { revision, exitCode, log: safeLog || 'No test output.' };
  }

  async function syncAndTest(credential, selection, { signal = new AbortController().signal } = {}) {
    if (typeof testRevision !== 'function') throw new Error('Stage 3 sync and test requires an enrolled test runner.');
    signal.throwIfAborted();
    return synchronize(credential, selection, async (receipt, binding, verifySession) => {
      await verifySession();
      signal.throwIfAborted();
      const test = await testPublishedRevision(binding, receipt.revision, signal, verifySession);
      return { ...receipt, test };
    });
  }

  async function watch(credential, selection, { signal, emit }) {
    if (typeof testRevision !== 'function') throw new Error('Stage 3 watch requires an enrolled test runner.');
    let ready = false;
    let seen;
    try {
      while (!signal.aborted) {
        await synchronize(credential, selection, async ({ revision }, binding, verifySession) => {
          if (revision === seen || signal.aborted) return;
          await verifySession();
          if (signal.aborted) return;
          if (!ready) {
            ready = true;
            emit({ type: 'ready' });
          }
          emit({ type: 'update', revision });
          const test = await testPublishedRevision(binding, revision, signal, verifySession);
          emit({ type: 'test', ...test });
          seen = revision;
        });
        if (!signal.aborted) await delay(1000, undefined, { signal });
      }
    } catch (error) {
      if (!(signal.aborted && error instanceof Error && error.name === 'AbortError')) throw error;
    }
    if (ready) emit({ type: 'stopped' });
  }

  return { sync: (credential, selection) => synchronize(credential, selection), syncAndTest, watch };
}
