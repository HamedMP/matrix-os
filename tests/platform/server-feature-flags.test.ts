import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLATFORM_FEATURE_FLAGS,
  createServerFeatureFlags,
  loadServerFlagSettings,
  resolveRuntimeSwitch,
  type ServerFeatureFlags,
} from '../../packages/platform/src/feature-flags/server-flags.js';

/**
 * Server-side PostHog flags (ENG-608) evaluated by the real posthog-node local
 * evaluator against a fake definitions endpoint. Faults detected: a switch
 * opening before definitions load, an outage turning features off (or on),
 * a missing flag reading as on, deployments without a key changing behavior,
 * per-request network calls, and distinct ids or emails leaving the platform.
 */

const OWNER = 'user_2abcDEF123';
const ENV = {
  POSTHOG_FEATURE_FLAGS_SECURE_API_KEY: 'phs_secure-test-key',
  POSTHOG_PROJECT_TOKEN: 'phc_project-token',
  POSTHOG_HOST: 'https://eu.i.posthog.com',
};
const SWITCH = { flag: PLATFORM_FEATURE_FLAGS.freeTierEnabled, whenUnconfigured: true, whenUnknown: false };

function flag(key: string, rollout: { active?: boolean; distinctIds?: string[] } = {}) {
  return {
    id: 1, key, active: rollout.active ?? true, ensure_experience_continuity: false,
    filters: {
      groups: [{
        rollout_percentage: 100,
        properties: rollout.distinctIds
          ? [{ key: 'distinct_id', type: 'person', operator: 'exact', value: rollout.distinctIds }]
          : [],
      }],
    },
  };
}

function definitions(flags: unknown[]) {
  return new Response(JSON.stringify({ flags, group_type_mapping: {}, cohorts: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

type Responder = () => Promise<Response> | Response;

function fakePostHog(initial: Responder) {
  let responder = initial;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, respond(next: Responder) { responder = next; } };
}

const created: ServerFeatureFlags[] = [];
function flagsFor(fake: ReturnType<typeof fakePostHog>, env: NodeJS.ProcessEnv = ENV, log = vi.fn()) {
  const flags = createServerFeatureFlags({ env, fetch: fake.fetch, pollIntervalMs: 100, log });
  created.push(flags);
  return { flags, log };
}

async function loaded(flags: ServerFeatureFlags, expected: boolean | undefined) {
  await vi.waitFor(async () => {
    expect(await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierEnabled, { distinctId: OWNER })).toBe(expected);
  }, { timeout: 2_000, interval: 20 });
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((flags) => flags.shutdown()));
});

describe('server feature flags', () => {
  it('without a key the client is unconfigured and switches keep env behavior', async () => {
    const fake = fakePostHog(() => definitions([]));
    const { flags } = flagsFor(fake, {});

    expect(flags.configured).toBe(false);
    expect(await resolveRuntimeSwitch(flags, SWITCH, { distinctId: OWNER })).toBe(true);
    expect(await resolveRuntimeSwitch(flags, { ...SWITCH, whenUnconfigured: false }, { distinctId: OWNER })).toBe(false);
    expect(await resolveRuntimeSwitch(undefined, SWITCH, { distinctId: OWNER })).toBe(true);
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('fails closed on cold start, before definitions load, without waiting on the network', async () => {
    let release!: () => void;
    const fake = fakePostHog(() => new Promise<Response>((resolve) => { release = () => resolve(definitions([flag('free-tier-enabled')])); }));
    const { flags } = flagsFor(fake);

    expect(flags.configured).toBe(true);
    // Answers immediately while the definitions request is still pending.
    expect(await resolveRuntimeSwitch(flags, SWITCH, { distinctId: OWNER })).toBe(false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await loaded(flags, true);
    expect(await resolveRuntimeSwitch(flags, SWITCH, { distinctId: OWNER })).toBe(true);
  });

  it('reads on, off, and missing flags from the definitions', async () => {
    const fake = fakePostHog(() => definitions([
      flag('free-tier-enabled'),
      flag('free-tier-sleep', { active: false }),
    ]));
    const { flags } = flagsFor(fake);
    await loaded(flags, true);

    expect(await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierSleep, { distinctId: OWNER })).toBe(false);
    // Missing from the project: unknown, so the switch takes its closed side.
    expect(await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierInviteRequired, { distinctId: OWNER })).toBeUndefined();
    expect(await resolveRuntimeSwitch(flags, {
      flag: PLATFORM_FEATURE_FLAGS.freeTierInviteRequired, whenUnconfigured: false, whenUnknown: true,
    }, { distinctId: OWNER })).toBe(true);
  });

  it('targets by Clerk user id for internal-first rollouts', async () => {
    const fake = fakePostHog(() => definitions([flag('free-tier-enabled', { distinctIds: [OWNER] })]));
    const { flags } = flagsFor(fake);
    await loaded(flags, true);

    expect(await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierEnabled, { distinctId: 'user_someoneelse' })).toBe(false);
  });

  it('keeps the last known definitions through a PostHog outage', async () => {
    const fake = fakePostHog(() => definitions([flag('free-tier-enabled')]));
    const { flags } = flagsFor(fake);
    await loaded(flags, true);
    const before = fake.calls.length;

    fake.respond(() => { throw new TypeError('fetch failed'); });
    await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(before + 1), { timeout: 2_000, interval: 20 });
    expect(await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierEnabled, { distinctId: OWNER })).toBe(true);

    const failing = fake.calls.length;
    fake.respond(() => new Response('unavailable', { status: 503 }));
    await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(failing + 1), { timeout: 2_000, interval: 20 });
    expect(await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierEnabled, { distinctId: OWNER })).toBe(true);
  });

  it('follows a flag turned off at the next poll, without a deploy', async () => {
    const fake = fakePostHog(() => definitions([flag('free-tier-enabled')]));
    const { flags } = flagsFor(fake);
    await loaded(flags, true);

    fake.respond(() => definitions([flag('free-tier-enabled', { active: false })]));
    await loaded(flags, false);
  });

  it('only downloads definitions, with a timeout and no redirects, and sends no distinct id or email', async () => {
    const fake = fakePostHog(() => definitions([flag('free-tier-enabled')]));
    const { flags, log } = flagsFor(fake);
    await loaded(flags, true);
    for (let i = 0; i < 20; i += 1) await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierEnabled, { distinctId: OWNER });
    // An email is never accepted as a distinct id.
    expect(await flags.evaluate(PLATFORM_FEATURE_FLAGS.freeTierEnabled, { distinctId: 'owner@example.com' })).toBeUndefined();
    await flags.shutdown();

    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      const url = new URL(call.url);
      expect(`${url.origin}${url.pathname}`).toBe('https://eu.i.posthog.com/api/feature_flag/local_evaluation');
      expect(call.url).not.toContain(OWNER);
      expect(call.url).not.toContain('example.com');
      expect(call.init.body).toBeUndefined();
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    // Evaluations are local: polling, not one request per evaluation.
    expect(fake.calls.length).toBeLessThan(20);
    expect(JSON.stringify(log.mock.calls)).not.toContain('phs_secure-test-key');
    expect(JSON.stringify(log.mock.calls)).not.toContain('owner@example.com');
  });
});

describe('flag settings', () => {
  it('reports invalid companion settings by name and fails closed', async () => {
    expect(loadServerFlagSettings({ POSTHOG_FEATURE_FLAGS_SECURE_API_KEY: 'phs_x' }))
      .toEqual({ kind: 'invalid', invalid: ['POSTHOG_PROJECT_TOKEN'] });
    expect(loadServerFlagSettings({ ...ENV, POSTHOG_FEATURE_FLAGS_HOST: '/relay' }))
      .toEqual({ kind: 'invalid', invalid: ['POSTHOG_FEATURE_FLAGS_HOST'] });
    expect(loadServerFlagSettings({ ...ENV, POSTHOG_FEATURE_FLAGS_SECURE_API_KEY: 'phc_public' }))
      .toEqual({ kind: 'invalid', invalid: ['POSTHOG_FEATURE_FLAGS_SECURE_API_KEY'] });
    const log = vi.fn();
    const fake = fakePostHog(() => definitions([flag('free-tier-enabled')]));
    const { flags } = flagsFor(fake, { POSTHOG_FEATURE_FLAGS_SECURE_API_KEY: 'phs_x' }, log);
    expect(flags.configured).toBe(true);
    expect(await resolveRuntimeSwitch(flags, SWITCH, { distinctId: OWNER })).toBe(false);
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('phs_x');
  });

  it('defaults to the EU API host and prefers the explicit flags host', () => {
    const { POSTHOG_HOST: _host, ...withoutHost } = ENV;
    expect(loadServerFlagSettings(withoutHost)).toMatchObject({ kind: 'ok', settings: { host: 'https://eu.i.posthog.com' } });
    expect(loadServerFlagSettings({ ...ENV, POSTHOG_FEATURE_FLAGS_HOST: 'https://eu.posthog.com/' }))
      .toMatchObject({ kind: 'ok', settings: { host: 'https://eu.posthog.com' } });
  });
});

describe('Cloud Run wiring', () => {
  it('binds the feature-flags secure key from Secret Manager only when opted in', async () => {
    const { readFile } = await import('node:fs/promises');
    const workflow = await readFile(new URL('../../.github/workflows/platform-cloud-run.yml', import.meta.url), 'utf8');

    expect(workflow).toContain("POSTHOG_SERVER_FLAGS_ENABLED: ${{ vars.POSTHOG_SERVER_FLAGS_ENABLED || 'false' }}");
    expect(workflow).toMatch(/if \[ "\$POSTHOG_SERVER_FLAGS_ENABLED" = "true" \]; then\n\s+posthog_flags_secret_bindings=",POSTHOG_FEATURE_FLAGS_SECURE_API_KEY=posthog-feature-flags-secure-api-key:latest"/);
    expect(workflow).toMatch(/--set-secrets "[^"]*\$\{posthog_flags_secret_bindings\}"/);
    // The key is a secret: never a plain env var or a GitHub variable.
    expect(workflow).not.toMatch(/POSTHOG_FEATURE_FLAGS_SECURE_API_KEY=\$\{/);
    expect(workflow).not.toContain('vars.POSTHOG_FEATURE_FLAGS_SECURE_API_KEY');
  });
});
