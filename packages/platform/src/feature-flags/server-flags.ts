import { PostHog, type PostHogOptions } from 'posthog-node';

/**
 * Server-side PostHog feature flags for the platform (ENG-608).
 *
 * Two layers decide whether a runtime feature is on:
 * - Env vars and Secret Manager hold secrets, infrastructure config, capacity
 *   numbers and "is this capability installed here" gates.
 * - PostHog flags hold the runtime on/off switch and its rollout.
 *
 * The effective state is the env capability AND the flag. Flags are evaluated
 * locally from definitions polled every 15 s with the feature-flags secure API
 * key, so a request never waits on PostHog. Until definitions first load, and
 * for a flag missing from the project, a switch takes its `whenUnknown` value
 * (fail closed). During a PostHog outage the last loaded definitions stay in
 * use. With no key configured at all, a switch takes `whenUnconfigured`, which
 * callers set to today's env behavior. See docs/dev/feature-flags.md.
 */

/** Every platform flag key. Add a key here to adopt a new flag. Values never carry secrets or limits. */
export const PLATFORM_FEATURE_FLAGS = {
  /** Gates new free signups/admission and the Free offer on the signup journey (ENG-520). */
  freeTierEnabled: 'free-tier-enabled',
  /** Gates the idle sleeper's suspends; scheduled wakes keep running (ENG-520 P6). */
  freeTierSleep: 'free-tier-sleep',
  /** When on, free admission requires an invite (spec 2691 decision D4). */
  freeTierInviteRequired: 'free-tier-invite-required',
} as const;

export type PlatformFeatureFlag = (typeof PLATFORM_FEATURE_FLAGS)[keyof typeof PLATFORM_FEATURE_FLAGS];

/**
 * Who a flag is evaluated for: a Clerk user id (so internal-first and
 * percentage rollouts work) or a fixed platform id for global switches. Never
 * an email or other personal data; ids that look like one are refused.
 */
export interface FlagSubject {
  distinctId: string;
}

export interface ServerFeatureFlags {
  /** False when no feature-flags key is configured; callers then fall back to env behavior. */
  readonly configured: boolean;
  /**
   * The flag's value from the loaded definitions, or undefined when definitions
   * have not loaded yet, the flag does not exist, or it cannot be evaluated
   * locally. Never makes a network call.
   */
  evaluate(flag: PlatformFeatureFlag, subject: FlagSubject): Promise<boolean | undefined>;
  /**
   * Calls `listener` after newly loaded definitions change `flag` (including the
   * first load), once the new definitions are in effect. An unchanged poll does
   * not call it. Returns an unsubscribe.
   */
  onFlagChange(flag: PlatformFeatureFlag, listener: () => void): () => void;
  /** Stops the definitions poller. */
  shutdown(): Promise<void>;
}

export interface RuntimeSwitch {
  flag: PlatformFeatureFlag;
  /** Value when the flag client is not configured (no key): today's env behavior. */
  whenUnconfigured: boolean;
  /** Value on cold start, for a missing flag, or when evaluation fails: the safe (closed) side. */
  whenUnknown: boolean;
}

/** Resolves one runtime switch for a subject. Use this rather than calling `evaluate` directly. */
export async function resolveRuntimeSwitch(
  flags: ServerFeatureFlags | undefined,
  runtimeSwitch: RuntimeSwitch,
  subject: FlagSubject,
): Promise<boolean> {
  if (!flags?.configured) return runtimeSwitch.whenUnconfigured;
  const value = await flags.evaluate(runtimeSwitch.flag, subject);
  return value ?? runtimeSwitch.whenUnknown;
}

/** 15 s keeps poll-to-effect under a minute for workers that react to changes (see onFlagChange). */
export const FLAG_DEFINITIONS_POLL_INTERVAL_MS = 15_000;
/** Bound on change listeners per client; a listener beyond it is refused and logged. */
export const MAX_FLAG_CHANGE_LISTENERS = 32;
export const FLAG_DEFINITIONS_TIMEOUT_MS = 10_000;
const DEFAULT_FLAGS_HOST = 'https://eu.i.posthog.com';
const LOCAL_EVALUATION_PATH = '/api/feature_flag/local_evaluation';
// Clerk user ids and fixed platform ids; no `@`, spaces, or anything email-shaped.
const SAFE_DISTINCT_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;

type Log = (event: string, fields: Record<string, string | number>) => void;
const defaultLog: Log = (event, fields) => console.warn(`[feature-flags] ${event}`, JSON.stringify(fields));

type PostHogFetch = NonNullable<PostHogOptions['fetch']>;

/** The slice of posthog-node the evaluator uses, so tests can observe it. */
export interface FlagClient {
  isLocalEvaluationReady(): boolean;
  isFeatureEnabled(key: string, distinctId: string, options: {
    onlyEvaluateLocally: true; sendFeatureFlagEvents: false; disableGeoip: true;
  }): Promise<boolean | undefined>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'localEvaluationFlagsLoaded', listener: () => void): unknown;
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface ServerFeatureFlagsOptions {
  env: NodeJS.ProcessEnv;
  /** Network fetch (tests inject a fake). */
  fetch?: typeof fetch;
  /** Overrides FLAG_DEFINITIONS_POLL_INTERVAL_MS (tests). */
  pollIntervalMs?: number;
  log?: Log;
}

interface FlagsSettings {
  secureApiKey: string;
  projectToken: string;
  host: string;
}

type SettingsResult = { kind: 'unconfigured' } | { kind: 'invalid'; invalid: string[] } | { kind: 'ok'; settings: FlagsSettings };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch (error: unknown) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** Reads the flag settings. Problems are reported by setting name only, never by value. */
export function loadServerFlagSettings(env: NodeJS.ProcessEnv): SettingsResult {
  const secureApiKey = nonEmpty(env.POSTHOG_FEATURE_FLAGS_SECURE_API_KEY);
  if (!secureApiKey) return { kind: 'unconfigured' };
  const invalid: string[] = [];
  // The public project token names the project; the secure key authorizes reading its flag definitions.
  const projectToken = nonEmpty(env.POSTHOG_PROJECT_TOKEN) ?? nonEmpty(env.POSTHOG_TOKEN);
  if (!projectToken) invalid.push('POSTHOG_PROJECT_TOKEN');
  if (secureApiKey.startsWith('phc_')) invalid.push('POSTHOG_FEATURE_FLAGS_SECURE_API_KEY');
  const hostSetting = nonEmpty(env.POSTHOG_FEATURE_FLAGS_HOST) ?? nonEmpty(env.POSTHOG_API_HOST) ?? nonEmpty(env.POSTHOG_HOST)
    ?? DEFAULT_FLAGS_HOST;
  const host = validHost(hostSetting);
  if (!host) invalid.push('POSTHOG_FEATURE_FLAGS_HOST');
  if (invalid.length > 0 || !projectToken || !host) return { kind: 'invalid', invalid };
  return { kind: 'ok', settings: { secureApiKey, projectToken, host } };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * The only request the flag client may make: the local-evaluation definitions
 * download, with a timeout and no redirects. Anything else (event capture,
 * remote evaluation) is refused, so no distinct id or property leaves the
 * platform.
 */
function definitionsOnlyFetch(
  host: string,
  networkFetch: typeof fetch,
  observe: (response: Response) => Promise<void>,
): PostHogFetch {
  const allowed = `${host}${LOCAL_EVALUATION_PATH}`;
  return async (url, options) => {
    const target = new URL(url);
    if (`${target.origin}${target.pathname}` !== allowed) throw new Error('feature flag client request refused');
    const timeout = AbortSignal.timeout(FLAG_DEFINITIONS_TIMEOUT_MS);
    const response = await networkFetch(url, {
      method: options.method,
      headers: options.headers,
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (response.status === 200) await observe(response.clone());
    return response;
  };
}

const noChanges = () => () => undefined;

/** A configured key whose companion settings are invalid: every flag reads unknown (fail closed). */
function closedFlags(): ServerFeatureFlags {
  return { configured: true, evaluate: async () => undefined, onFlagChange: noChanges, shutdown: async () => undefined };
}

const KNOWN_FLAGS: readonly PlatformFeatureFlag[] = Object.values(PLATFORM_FEATURE_FLAGS);

/**
 * Tracks each platform flag's definition across polls. A downloaded body is
 * compared when it arrives; listeners run on posthog-node's load event, after
 * the new definitions are applied. Bounded: one fingerprint per platform flag.
 */
export interface FlagChangeTracker {
  observe(response: Response): Promise<void>;
  applied(): void;
  subscribe(flag: PlatformFeatureFlag, listener: () => void): () => void;
}

export function createFlagChangeTracker(log: Log = defaultLog): FlagChangeTracker {
  const fingerprints = new Map<PlatformFeatureFlag, string>();
  const listeners = new Set<{ flag: PlatformFeatureFlag; listener: () => void }>();
  let pending = new Set<PlatformFeatureFlag>();
  return {
    async observe(response) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (error: unknown) {
        // posthog-node reads the same body and reports it; nothing changed here.
        log('flag_definitions_unreadable', { code: errorName(error) });
        return;
      }
      const flags = (body as { flags?: unknown } | null)?.flags;
      if (!Array.isArray(flags)) return;
      for (const key of KNOWN_FLAGS) {
        const definition = flags.find((entry) => (entry as { key?: unknown } | null)?.key === key) ?? null;
        const fingerprint = JSON.stringify(definition);
        if (fingerprints.get(key) !== fingerprint) {
          fingerprints.set(key, fingerprint);
          pending.add(key);
        }
      }
    },
    applied() {
      const changed = pending;
      pending = new Set();
      if (changed.size === 0) return;
      for (const entry of [...listeners]) {
        if (!changed.has(entry.flag)) continue;
        try {
          entry.listener();
        } catch (error: unknown) {
          log('flag_change_listener_failed', { flag: entry.flag, code: errorName(error) });
        }
      }
    },
    subscribe(flag, listener) {
      if (listeners.size >= MAX_FLAG_CHANGE_LISTENERS) {
        log('flag_change_listener_refused', { flag });
        return () => undefined;
      }
      const entry = { flag, listener };
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
  };
}

export function createServerFeatureFlagsFromClient(
  client: FlagClient,
  log: Log = defaultLog,
  changes: FlagChangeTracker = createFlagChangeTracker(log),
): ServerFeatureFlags {
  client.on('error', (error: unknown) => {
    // posthog-node's messages are generic, but only the error class is logged.
    log('flag_definitions_error', { code: errorName(error) });
  });
  client.on('localEvaluationFlagsLoaded', () => changes.applied());
  return {
    configured: true,
    onFlagChange: (flag, listener) => changes.subscribe(flag, listener),
    async evaluate(flag, subject) {
      if (!SAFE_DISTINCT_ID.test(subject.distinctId)) {
        log('flag_subject_refused', { flag });
        return undefined;
      }
      // Before the first load posthog-node would fetch inline; answering unknown keeps requests off the network.
      if (!client.isLocalEvaluationReady()) return undefined;
      try {
        return await client.isFeatureEnabled(flag, subject.distinctId, {
          onlyEvaluateLocally: true, sendFeatureFlagEvents: false, disableGeoip: true,
        });
      } catch (error: unknown) {
        log('flag_evaluation_failed', { flag, code: errorName(error) });
        return undefined;
      }
    },
    async shutdown() {
      try {
        await client.shutdown(FLAG_DEFINITIONS_TIMEOUT_MS);
      } catch (error: unknown) {
        log('flag_client_shutdown_failed', { code: errorName(error) });
      }
    },
  };
}

/**
 * Startup composition. Returns an unconfigured client (env fallback) when
 * `POSTHOG_FEATURE_FLAGS_SECURE_API_KEY` is unset, and a fail-closed one when
 * the key is set but its companion settings are invalid.
 */
export function createServerFeatureFlags(options: ServerFeatureFlagsOptions): ServerFeatureFlags {
  const log = options.log ?? defaultLog;
  const loaded = loadServerFlagSettings(options.env);
  if (loaded.kind === 'unconfigured') {
    return { configured: false, evaluate: async () => undefined, onFlagChange: noChanges, shutdown: async () => undefined };
  }
  if (loaded.kind === 'invalid') {
    log('flag_client_unconfigured', { invalid: loaded.invalid.join(',') });
    return closedFlags();
  }
  const { settings } = loaded;
  const changes = createFlagChangeTracker(log);
  const client = new PostHog(settings.projectToken, {
    host: settings.host,
    personalApiKey: settings.secureApiKey,
    featureFlagsPollingInterval: options.pollIntervalMs ?? FLAG_DEFINITIONS_POLL_INTERVAL_MS,
    requestTimeout: FLAG_DEFINITIONS_TIMEOUT_MS,
    fetch: definitionsOnlyFetch(settings.host, options.fetch ?? fetch, (response) => changes.observe(response)),
    disableGeoip: true,
    sendFeatureFlagEvent: false,
  });
  return createServerFeatureFlagsFromClient(client as unknown as FlagClient, log, changes);
}
