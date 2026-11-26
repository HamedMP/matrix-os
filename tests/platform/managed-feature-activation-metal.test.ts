import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FUNDED_PREVIEW_PLATFORM_ORIGINS, FUNDED_PREVIEW_RELAY_ORIGIN, fundedHostActivationRevisionInput, fundedPlatformOriginMatchesGuest,
} from '@matrix-os/contracts';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { FREE_MANAGED_MODEL_ID } from '../../packages/platform/src/free-tier/funded-policy.js';
import { fundedPlatformOrigin, isAdmittedFundedOriginPair } from '../../packages/platform/src/funded-host-activation.js';
import {
  createManagedFeatureActivator,
  createManagedFeatureResumeTrigger,
} from '../../packages/platform/src/managed-feature-activation.js';
import { wakeOnDemandRuntime } from '../../packages/platform/src/substrates/substrate-wake.js';
import type { FakeIngressRequest } from './fake-metal-ingress.js';
import { createMetalWakeRig, GENERATION, HANDLE, INGRESS_TOKEN, OWNER, VM_ID, type MetalWakeRig } from './metal-wake-rig.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

/**
 * Matrix AI activation for metal runtimes (spec 2691, ENG-520 Task P8).
 * A metal VM has no public IPv4; the funded config must reach it through the
 * host ingress (credential, verified TLS, canonical Host, exact VM target) the routing proxy uses.
 *
 * Faults detected: activation sent to a public IPv4 a metal VM does not have
 * (every free runtime stuck without Matrix AI), activation that wakes or keeps
 * awake an idle VM, an asleep VM counted as a failure, a VPS activation
 * changed by the metal branch, and a woken VM left waiting for a full sweep.
 */

const secret = 'strong-platform-secret-for-test-only';
const at = '2026-11-21T10:00:00.000Z';
const relayOrigin = 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app';
const CONFIG_PATH = '/api/internal/platform-funded-ai/config';

async function fundRuntime(db: PlatformDB, machineId: string, owner: string): Promise<void> {
  await db.executor.insertInto('ai_funded_runtime_policies').values({
    machine_id: machineId, owner_id: owner, runtime_slot: 'primary', enabled: true,
    allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']), monthly_budget_microusd: 100,
    expires_at: null, next_issue_at: at, revision: 1, created_at: at, updated_at: at,
  }).execute();
}

/** A VM gateway that stores the posted config and reports its revision. */
function configuringVm(): { respond: (request: FakeIngressRequest) => { status: number; body: unknown } | undefined } {
  let revision: string | null = null;
  return {
    respond(request) {
      if (!request.path.startsWith(CONFIG_PATH)) return undefined;
      if (request.method === 'POST') {
        revision = createHash('sha256').update(fundedHostActivationRevisionInput(JSON.parse(request.body))).digest('hex');
        return { status: 202, body: { status: 'restarting' } };
      }
      return { status: 200, body: { configured: revision !== null, configurationRevision: revision } };
    },
  };
}

describe('managed feature activation for metal runtimes', () => {
  let db: PlatformDB;
  let rig: MetalWakeRig;
  const resumed: Array<{ handle: string }> = [];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await db.executor.updateTable('ai_funded_global_policy')
      .set({ enabled: true, allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']) }).execute();
    resumed.length = 0;
    rig = await createMetalWakeRig(db, {
      status: 'running', activationState: 'authorized', runtimeSlot: 'primary', runtimeTokenEpoch: 2,
      publicIPv4: '203.0.113.10',
    }, { onResumed: (ref) => { resumed.push({ handle: ref.handle }); } });
    await fundRuntime(db, rig.machineId, OWNER);
  });

  afterEach(async () => {
    await rig.close();
    await destroyTestPlatformDb(db);
  });

  function activator(fetchImpl?: typeof fetch) {
    return createManagedFeatureActivator({
      db, platformSecret: secret, relayOrigin, fundedAiEnabled: true, speechEnabled: false,
      activateSpeech: vi.fn(async () => ({ activated: 0, failed: 0 })), substrates: rig.substrates,
      ...(fetchImpl ? { fetchImpl } : {}), now: () => new Date(at), wait: async () => {},
    });
  }

  it('activates a running metal runtime through the hostd ingress', async () => {
    rig.ingress.respond = configuringVm().respond;
    expect(await activator()({})).toEqual({ activated: 1, failed: 0, complete: true, nextCursor: null });
    const config = rig.ingress.requests.filter((request) => request.path === CONFIG_PATH);
    expect(config.map((request) => request.method)).toEqual(['GET', 'POST', 'GET']);
    for (const request of config) {
      expect(request.headers['x-matrix-host-auth']).toBe(INGRESS_TOKEN);
      expect(request.headers.host).toBe('app.matrix-os.com');
      expect(request.headers['x-matrix-vm-target']).toBe(`${VM_ID}:${GENERATION}`);
      expect(request.headers['x-matrix-upstream-host']).toBeUndefined();
      expect(request.headers.authorization).toMatch(/^Bearer \S+$/);
    }
    expect(JSON.parse(config[1]!.body)).toMatchObject({
      identity: { machineId: rig.machineId, runtimeTokenEpoch: 2 }, configuration: { enabled: true, relayOrigin },
    });
  });

  it('does not use publicIPv4 for metal', async () => {
    rig.ingress.respond = configuringVm().respond;
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
    expect(await activator(fetchImpl as typeof fetch)({})).toMatchObject({ activated: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).not.toContain('203.0.113.10');
      expect(String(url)).toBe(`https://${rig.ingress.ingressHost}${CONFIG_PATH}`);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }

    // Without a metal upstream (no substrate registry) the VPS address is never a fallback.
    const fallback = vi.fn(async () => Response.json({}));
    const unrouted = createManagedFeatureActivator({
      db, platformSecret: secret, relayOrigin, fundedAiEnabled: true, speechEnabled: false,
      activateSpeech: vi.fn(async () => ({ activated: 0, failed: 0 })), fetchImpl: fallback as typeof fetch,
      now: () => new Date(at), wait: async () => {},
    });
    expect(await unrouted({})).toMatchObject({ activated: 0, failed: 1 });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('activates a realistic free metal runtime (no public IPv4, epoch 1, free GLM policy) through the ingress', async () => {
    await rig.close();
    await destroyTestPlatformDb(db);
    ({ db } = await createTestPlatformDb());
    await db.executor.updateTable('ai_funded_global_policy')
      .set({ enabled: true, allowed_model_ids: JSON.stringify([FREE_MANAGED_MODEL_ID]) }).execute();
    rig = await createMetalWakeRig(db, {
      status: 'running', activationState: 'authorized', runtimeSlot: 'primary', runtimeTokenEpoch: 1, publicIPv4: null,
    }, { onResumed: () => {} });
    await db.executor.insertInto('ai_funded_runtime_policies').values({
      machine_id: rig.machineId, owner_id: OWNER, runtime_slot: 'primary', enabled: true,
      allowed_model_ids: JSON.stringify([FREE_MANAGED_MODEL_ID]), monthly_budget_microusd: 0,
      expires_at: null, next_issue_at: at, revision: 1, created_at: at, updated_at: at,
    }).execute();
    rig.ingress.respond = configuringVm().respond;

    expect(await activator()({ handle: HANDLE })).toEqual({ activated: 1, failed: 0, complete: true, nextCursor: null });
    const posted = rig.ingress.requests.find((request) => request.path === CONFIG_PATH && request.method === 'POST');
    expect(JSON.parse(posted!.body)).toMatchObject({ identity: { machineId: rig.machineId, runtimeTokenEpoch: 1 } });
  });

  it('activates a free metal VM on a preview platform with the reviewed preview pair, through the ingress', async () => {
    const previewRelay = 'https://matrix-ai-relay-preview-jqxkjdhtkq-ey.a.run.app';
    const previewPlatform = fundedPlatformOrigin({
      PLATFORM_PREVIEW: 'true', MATRIX_FUNDED_AI_PREVIEW_PIN: '1',
      MATRIX_APP_ORIGIN: 'https://metal-preview.matrix-os.com', PLATFORM_PUBLIC_URL: 'https://metal-preview.matrix-os.com',
    });
    expect(previewPlatform).toBe('https://metal-preview.matrix-os.com');
    rig.ingress.respond = configuringVm().respond;

    const activate = createManagedFeatureActivator({
      db, platformSecret: secret, relayOrigin: previewRelay, platformOrigin: previewPlatform, fundedAiEnabled: true,
      speechEnabled: false, activateSpeech: vi.fn(async () => ({ activated: 0, failed: 0 })), substrates: rig.substrates,
      now: () => new Date(at), wait: async () => {},
    });

    expect(await activate({ handle: HANDLE })).toEqual({ activated: 1, failed: 0, complete: true, nextCursor: null });
    const posted = rig.ingress.requests.find((request) => request.path === CONFIG_PATH && request.method === 'POST');
    expect(JSON.parse(posted!.body)).toMatchObject({
      configuration: { platformOrigin: 'https://metal-preview.matrix-os.com', relayOrigin: previewRelay },
    });
  });

  it('a production platform keeps the production origin and rejects the preview relay', async () => {
    const preview = { PLATFORM_PREVIEW: 'true', MATRIX_FUNDED_AI_PREVIEW_PIN: '1', MATRIX_APP_ORIGIN: 'https://metal-preview.matrix-os.com' };
    // Default (production) env: the preview pin is off and guests get the production origin.
    expect(fundedPlatformOrigin({})).toBe('https://app.matrix-os.com');
    expect(fundedPlatformOrigin({ MATRIX_APP_ORIGIN: 'https://metal-preview.matrix-os.com' })).toBe('https://app.matrix-os.com');
    // A preview that can provision Hetzner VPSes is production-gated too.
    expect(fundedPlatformOrigin({ ...preview, HETZNER_API_TOKEN: 'token' })).toBe('https://app.matrix-os.com');
    // So is a preview without the explicit preview-pin flag the preview workflow sets.
    expect(fundedPlatformOrigin({ PLATFORM_PREVIEW: 'true', MATRIX_APP_ORIGIN: 'https://metal-preview.matrix-os.com' })).toBe('https://app.matrix-os.com');
  });

  it('a pinned preview platform with no configured origin emits nothing, never the production pair', async () => {
    expect(fundedPlatformOrigin({ PLATFORM_PREVIEW: 'true', MATRIX_FUNDED_AI_PREVIEW_PIN: '1' })).toBeNull();
    expect(fundedPlatformOrigin({ PLATFORM_PREVIEW: 'true', MATRIX_FUNDED_AI_PREVIEW_PIN: '1', MATRIX_APP_ORIGIN: 'not a url' })).toBeNull();
    rig.ingress.respond = configuringVm().respond;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const activate = createManagedFeatureActivator({
      db, platformSecret: secret, relayOrigin, platformOrigin: null, fundedAiEnabled: true, speechEnabled: false,
      activateSpeech: vi.fn(async () => ({ activated: 0, failed: 0 })), substrates: rig.substrates,
      now: () => new Date(at), wait: async () => {},
    });
    expect(await activate({ handle: HANDLE })).toEqual({ activated: 0, failed: 0, complete: true, nextCursor: null });
    expect(rig.ingress.requests.filter((request) => request.path === CONFIG_PATH)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('never sends a relay origin outside the reviewed pin, and says so once instead of a ZodError per pass', async () => {
    // The live preview platform's relay: a real Cloud Run origin the contract does not admit.
    const previewRelay = 'https://matrix-ai-relay-preview-jqxkjdhtkq-ey.a.run.app';
    rig.ingress.respond = configuringVm().respond;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const activate = createManagedFeatureActivator({
      db, platformSecret: secret, relayOrigin: previewRelay, fundedAiEnabled: true, speechEnabled: false,
      activateSpeech: vi.fn(async () => ({ activated: 0, failed: 0 })), substrates: rig.substrates,
      now: () => new Date(at), wait: async () => {},
    });
    expect(await activate({})).toEqual({ activated: 0, failed: 0, complete: true, nextCursor: null });
    expect(await activate({ handle: HANDLE })).toEqual({ activated: 0, failed: 0, complete: true, nextCursor: null });

    expect(rig.ingress.requests.filter((request) => request.path === CONFIG_PATH)).toEqual([]);
    expect(warn.mock.calls.flat().map(String)).not.toContain('ZodError');
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('relay and platform origins');
    expect(JSON.stringify(error.mock.calls)).not.toContain(previewRelay);
  });

  it('logs only the failing schema paths when funded configuration does not parse', async () => {
    await db.executor.updateTable('ai_funded_runtime_policies')
      .set({ allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5', `secret-${'x'.repeat(130)}`]) }).execute();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await activator()({})).toMatchObject({ activated: 0, failed: 1 });

    expect(warn).toHaveBeenCalledWith('[managed-features] funded activation deferred', 'ZodError', { paths: ['1'] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-');
  });

  it('metal runtime_asleep answer is skipped, not failed', async () => {
    rig.ingress.asleepResponses = 1;
    expect(await activator()({})).toEqual({ activated: 0, failed: 0, complete: true, nextCursor: null });
    expect(rig.resumeCalls()).toEqual([]);
    const machine = await rig.machine();
    expect(machine?.status).toBe('running');
    expect(rig.ingress.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('a VM app answering a runtime_asleep body without the ingress marker is a failure, not skipped', async () => {
    rig.ingress.vmAsleepBodyResponses = 1;
    expect(await activator()({})).toMatchObject({ activated: 0, failed: 1 });
  });

  it('activation does not stamp last_activity_at', async () => {
    rig.ingress.respond = configuringVm().respond;
    expect(await activator()({})).toMatchObject({ activated: 1 });
    const machine = await rig.machine();
    expect(machine?.lastActivityAt ?? null).toBeNull();
  });

  it('a metal resume triggers a targeted activation for that handle', async () => {
    await db.executor.updateTable('user_machines').set({ status: 'suspended' })
      .where('machine_id', '=', rig.machineId).execute();
    const suspended = await rig.machine();
    const metal = rig.substrates.get('metal');
    if (!metal.ok) throw new Error('metal substrate missing');
    const woke = await wakeOnDemandRuntime(db, metal.substrate, suspended!);
    expect(woke.result).toEqual({ state: 'running' });
    expect(resumed).toEqual([{ handle: HANDLE }]);

    // A wake of a record that was already running is not a resume.
    await wakeOnDemandRuntime(db, metal.substrate, (await rig.machine())!);
    expect(resumed).toHaveLength(1);
  });
});

describe('managed feature resume trigger', () => {
  it('runs one targeted activation per handle at a time and logs failures by name', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activate = vi.fn(async (_target: { handle?: string; signal?: AbortSignal }) => {
      await gate;
      return { activated: 1, failed: 0, complete: true, nextCursor: null };
    });
    const trigger = createManagedFeatureResumeTrigger(activate);
    trigger({ handle: 'alice' });
    trigger({ handle: 'alice' });
    trigger({ handle: 'bob' });
    expect(activate.mock.calls.map(([target]) => (target as { handle?: string }).handle)).toEqual(['alice', 'bob']);
    release();
    await vi.waitFor(() => expect(trigger.inFlight()).toBe(0));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing = createManagedFeatureResumeTrigger(vi.fn(async () => { throw new TypeError('secret detail'); }));
      failing({ handle: 'alice' });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[managed-features] resume activation failed', 'TypeError'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
    } finally { warn.mockRestore(); }
  });

  it('after stop() a new trigger is a no-op, stop aborts in-flight work, and drain() waits for it', async () => {
    let finished = false;
    const signals: AbortSignal[] = [];
    const activate = vi.fn((target: { handle?: string; signal?: AbortSignal }) => {
      signals.push(target.signal!);
      return new Promise<{ activated: number; failed: number; complete: boolean; nextCursor: null }>((resolve) => {
        target.signal!.addEventListener('abort', () => {
          setTimeout(() => { finished = true; resolve({ activated: 0, failed: 1, complete: true, nextCursor: null }); }, 20);
        }, { once: true });
      });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const trigger = createManagedFeatureResumeTrigger(activate);
      trigger({ handle: 'alice' });
      expect(signals[0]?.aborted).toBe(false);
      trigger.stop();
      expect(signals[0]?.aborted).toBe(true);
      trigger({ handle: 'bob' });
      expect(activate).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);
      await trigger.drain();
      expect(finished).toBe(true);
      expect(trigger.inFlight()).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it('logs a triggered activation that reports failures with the handle and counts only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const trigger = createManagedFeatureResumeTrigger(vi.fn(async () => ({ activated: 0, failed: 1, complete: true, nextCursor: null })));
      trigger({ handle: 'alice' });
      await trigger.drain();
      expect(warn).toHaveBeenCalledWith('[managed-features] resume activation deferred', { handle: 'alice', activated: 0, failed: 1 });
    } finally { warn.mockRestore(); }
  });

  it('caps in-flight activations and drops extra resumes for the periodic pass', async () => {
    const activate = vi.fn(() => new Promise<never>(() => {}));
    const trigger = createManagedFeatureResumeTrigger(activate, { maxInFlight: 2 });
    for (const handle of ['a', 'b', 'c']) trigger({ handle });
    expect(activate).toHaveBeenCalledTimes(2);
    expect(trigger.inFlight()).toBe(2);
  });
});

describe('vps activation', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await db.executor.updateTable('ai_funded_global_policy')
      .set({ enabled: true, allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']) }).execute();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('vps activation unchanged', async () => {
    const machineId = '12345678-1234-4234-8234-123456789abc';
    await insertUserMachine(db, { machineId, clerkUserId: 'user_bob', handle: 'bob', runtimeSlot: 'primary', status: 'running',
      activationState: 'authorized', runtimeTokenEpoch: 2, publicIPv4: '203.0.113.10', provisionedAt: at });
    await fundRuntime(db, machineId, 'user_bob');
    let revision: string | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'POST') {
        revision = createHash('sha256').update(fundedHostActivationRevisionInput(JSON.parse(String(options.body)))).digest('hex');
        return Response.json({ status: 'restarting' }, { status: 202 });
      }
      return Response.json({ configured: revision !== null, configurationRevision: revision });
    });
    const dispatcher = { marker: 'vps-pool' } as never;
    const substrates = { get: vi.fn(), resolveUpstream: vi.fn() };
    const activate = createManagedFeatureActivator({ db, platformSecret: secret, relayOrigin, fundedAiEnabled: true,
      speechEnabled: false, activateSpeech: vi.fn(async () => ({ activated: 0, failed: 0 })), substrates,
      fetchImpl: fetchImpl as typeof fetch, fetchDispatcher: dispatcher, now: () => new Date(at), wait: async () => {} });
    expect(await activate({})).toMatchObject({ activated: 1, failed: 0 });
    expect(substrates.resolveUpstream).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`https://203.0.113.10:443${CONFIG_PATH}`, 'GET'],
      [`https://203.0.113.10:443${CONFIG_PATH}`, 'POST'],
      [`https://203.0.113.10:443${CONFIG_PATH}`, 'GET'],
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      const options = init as RequestInit & { dispatcher?: unknown };
      expect(options.dispatcher).toBe(dispatcher);
      expect(new Headers(options.headers).get('x-matrix-host-auth')).toBeNull();
    }
  });
});

/**
 * The preview deployment's own settings (spec 2691, ENG-520): the preview
 * workflow pins the preview funded-AI pair only when the deployed public origin
 * and relay are both reviewed, and guests take that public origin as their
 * PLATFORM_INTERNAL_URL. Faults detected: a preview that never pins (guests on
 * a preview platform receive the production origin and reject it), and a pin
 * set for an unreviewed origin or relay.
 */
describe('preview workflow funded-AI pin', () => {
  const workflow = readFileSync('.github/workflows/preview-platform.yml', 'utf8');
  const block = /# BEGIN funded-preview-pin[^\n]*\n([\s\S]*?)\n\s*# END funded-preview-pin/.exec(workflow)?.[1];

  function pinFor(publicUrl: string, relay: string): string {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `${block}\nprintf '%s' "$funded_preview_pin"`], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', PREVIEW_PUBLIC_URL: publicUrl, MATRIX_FUNDED_AI_RELAY_URL: relay },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  it('deploys the pin, and the deployed origins form the reviewed pair guests accept', () => {
    expect(block).toBeDefined();
    expect(workflow).toContain('funded_ai_env_bindings="${funded_ai_env_bindings}${funded_preview_pin}"');
    // The guest's PLATFORM_INTERNAL_URL is PLATFORM_PUBLIC_URL, and the platform's own origin is MATRIX_APP_ORIGIN.
    for (const binding of ['PLATFORM_PREVIEW=true', 'PLATFORM_PUBLIC_URL=${PREVIEW_PUBLIC_URL}', 'MATRIX_APP_ORIGIN=${PREVIEW_PUBLIC_URL}']) {
      expect(workflow).toContain(`|${binding}|`);
    }
    expect(workflow).not.toContain('HETZNER_API_TOKEN');
    for (const publicUrl of FUNDED_PREVIEW_PLATFORM_ORIGINS) {
      const pin = pinFor(`${publicUrl}/`, FUNDED_PREVIEW_RELAY_ORIGIN);
      expect(pin).toBe('|MATRIX_FUNDED_AI_PREVIEW_PIN=1');
      const origin = fundedPlatformOrigin({
        PLATFORM_PREVIEW: 'true', MATRIX_FUNDED_AI_PREVIEW_PIN: '1', MATRIX_APP_ORIGIN: `${publicUrl}/`, PLATFORM_PUBLIC_URL: `${publicUrl}/`,
      });
      expect(isAdmittedFundedOriginPair(origin, FUNDED_PREVIEW_RELAY_ORIGIN)).toBe(true);
      expect(fundedPlatformOriginMatchesGuest(origin, `${publicUrl}/`)).toBe(true);
    }
  });

  it('leaves a per-PR or unreviewed preview, or any other relay, on the production pair', () => {
    expect(pinFor('https://pr-12---matrix-platform-preview-jqxkjdhtkq-ey.a.run.app', FUNDED_PREVIEW_RELAY_ORIGIN)).toBe('');
    expect(pinFor('https://metal-preview.matrix-os.com', relayOrigin)).toBe('');
    expect(pinFor('https://metal-preview.matrix-os.com.evil.test', FUNDED_PREVIEW_RELAY_ORIGIN)).toBe('');
  });
});
