import { createGoogleManagedBrokerTransport } from '../google-data/managed/broker.js';
import type { GoogleQualifiedCredentialManager } from '../google-data/managed/credential-manager.js';
import type { GoogleDataPilotConfig } from '../google-data/runtime/pilot-config.js';
import { isManagedPiBinding } from '../bots/runtime-registry.js';
import type { Kysely } from 'kysely';
import { isDeepStrictEqual } from 'node:util';
import type { BotRuntimeRegistry, PiRuntimeBinding } from '../bots/runtime-registry.js';
import type { BotIntegrationTransport } from '../bots/integration-client.js';
import type { MatrixAnthropicAuthority } from '../bots/matrix-anthropic-api.js';
import { createGoogleContextStore } from '../google-data/runtime/contexts.js';
import { createGoogleRunPinStore } from '../google-data/runtime/run-pins.js';
import { createGooglePlatformPolicyClient } from '../google-data/runtime/platform-client.js';
import { createGoogleRuntimeInferenceAuthority } from '../google-data/runtime/runtime-authority.js';
import { GoogleInferenceIdentitySchema } from '../google-data/runtime/profile-resolution.js';
import { googleInferenceIdentity, type GoogleDataInferenceAuthority, type GoogleInferenceIdentity } from '../google-data/runtime/inference-policy.js';
import { createGoogleCollectionClient, GoogleCollectionClientError, type GoogleCollectionClientDependencies } from '../google-data/runtime/collection-client.js';
import { createGoogleOwnerConsentClient } from '../google-data/runtime/owner-consent-client.js';
import { createGoogleToolEgressGuard } from '../google-data/runtime/tool-egress.js';

/** Owner database composition only. Missing platform transport denies classified
 * Google work. No profiles, consent or classification are invented at startup;
 * unknown saved history still requires admission before its content is read. */
export async function createGoogleBrokerRuntime<DB>(options: {
  database: Kysely<DB>; registry: BotRuntimeRegistry; transport?: BotIntegrationTransport;
  /** The exact broker credential authority, not a caller-provided identity or a funded token lease. */
  credentials?: Pick<MatrixAnthropicAuthority, 'credential' | 'revalidate'>;
  qualifiedCredentials?: GoogleQualifiedCredentialManager;
  /** Production always supplies explicit host admission. Absence is library-level uninstalled composition. */
  pilotAdmission?: GoogleDataPilotConfig;
}) {
  const contexts = createGoogleContextStore(options.database);
  const pins = createGoogleRunPinStore(options.database);
  await contexts.migrate();
  await pins.migrate();
  const transport: BotIntegrationTransport = options.transport ?? (async () => { throw new Error('Google policy transport unavailable'); });
  const policyClient = createGooglePlatformPolicyClient(transport);
  const ownerConsentClient = createGoogleOwnerConsentClient(transport);
  const closing = new AbortController();
  let closed = false;
  let collections = 0; let collectionDrain = Promise.resolve(); let collectionsDone: (() => void) | undefined;
  let databaseWork = 0; let databaseDrain = Promise.resolve(); let databaseDone: (() => void) | undefined;
  const deny = (): never => { throw new GoogleCollectionClientError(); };
  // A collection abort can race a database wait. Drain actual SQL settlement before the host closes its pool.
  async function trackedDatabase<T>(operation: () => Promise<T>): Promise<T> {
    if (closed || databaseWork >= 64) deny();
    if (databaseWork++ === 0) databaseDrain = new Promise(resolve => { databaseDone = resolve; });
    try { return await operation(); }
    finally { if (--databaseWork === 0) { databaseDone?.(); databaseDone = undefined; } }
  }
  const collectionContexts = {
    inspect: (...args: Parameters<typeof contexts.inspect>) => trackedDatabase(() => contexts.inspect(...args)),
    mark: (input: Parameters<typeof contexts.mark>[0]) => trackedDatabase(() => contexts.mark(input)),
  };
  const collectionPins = {
    get: (...args: Parameters<typeof pins.get>) => trackedDatabase(() => pins.get(...args)),
    latch: (...args: Parameters<typeof pins.latch>) => trackedDatabase(() => pins.latch(...args)),
  };
  const authority = createGoogleRuntimeInferenceAuthority({ registry: options.registry, contexts: collectionContexts, pins: collectionPins, policyClient });
  const managed = createGoogleManagedBrokerTransport({ registry: options.registry, contexts: collectionContexts, credentials: options.qualifiedCredentials, lifetime: closing.signal });
  const pilotOwner = (binding: PiRuntimeBinding) => options.pilotAdmission?.enabled === true && isManagedPiBinding(binding)
    && binding.ownerId === options.pilotAdmission.ownerId;
  const toolEgress = createGoogleToolEgressGuard({ registry: options.registry, contexts: collectionContexts });
  const observed = new Map<string, { binding: PiRuntimeBinding; identity: GoogleInferenceIdentity; signal: AbortSignal; expiresAt: number }>(); // <=64; TTL/LRU eviction and shutdown clear.
  const live = (binding: PiRuntimeBinding) => {
    if (closed) return null;
    const signal = options.registry.inferenceSignal(binding);
    return signal && !signal.aborted && isDeepStrictEqual(options.registry.lookupRun(binding), binding) ? signal : null;
  };
  const sweep = () => {
    for (const [key, value] of observed) if (value.expiresAt <= Date.now() || live(value.binding) !== value.signal) observed.delete(key);
  };
  const observedIdentity = (binding: PiRuntimeBinding): GoogleInferenceIdentity | null => {
    sweep(); const value = observed.get(binding.runtimeHandle);
    return value && isDeepStrictEqual(value.binding, binding) ? structuredClone(value.identity) : null;
  };
  const resolveIdentity = async (binding: PiRuntimeBinding, signal: AbortSignal): Promise<GoogleInferenceIdentity | null> => {
    if (options.pilotAdmission && !pilotOwner(binding)) return null;
    if (binding.accessSourceId === 'matrix_included') {
      try { return await managed.resolveIdentity(binding, AbortSignal.any([signal, closing.signal])); }
      catch (error) { console.warn('[google-data] Managed processing identity unavailable'); return null; }
    }
    const identity = observedIdentity(binding); const runSignal = live(binding); const credentials = options.credentials;
    // Only the current explicit API-key broker exposes a durable credential generation.
    // Managed relay tokens and delegated/native subscriptions cannot stand in for processor evidence.
    if (!identity || !runSignal || !credentials || binding.accessSourceId !== 'owner_anthropic_key' || !binding.anthropicApi
      || binding.route.api !== 'anthropic-messages' || identity.api !== binding.route.api || identity.modelId !== binding.route.modelId
      || identity.credential.kind !== 'api_key' || identity.credential.generation !== binding.anthropicApi.credentialGeneration) return null;
    const current = () => {
      if (signal.aborted || live(binding) !== runSignal || !isDeepStrictEqual(observedIdentity(binding), identity)) deny();
    };
    async function checked<T>(operation: () => Promise<T>): Promise<T> {
      current(); const value = await operation(); current(); return value;
    }
    if (!await checked(() => credentials.revalidate(binding, signal))) return null;
    const key = await checked(() => credentials.credential(binding, signal));
    if (!await checked(() => credentials.revalidate(binding, signal))) return null;
    // Endpoint and adapter are observed at actual dispatch; never synthesize an SDK default.
    const fresh = googleInferenceIdentity(binding, identity.endpoint, { kind: 'api_key', value: key });
    return isDeepStrictEqual(fresh, identity) ? fresh : null;
  };
  const inference: GoogleDataInferenceAuthority = {
    managed,
    async authorize(input) {
      if (closed) return { allowed: false };
      const binding = structuredClone(input.binding);
      const candidate = input.identity === null ? null : structuredClone(input.identity);
      if (options.pilotAdmission?.enabled && !pilotOwner(binding)) return { allowed: false };
      if (options.pilotAdmission && !pilotOwner(binding) && await managed.required(binding, input.signal)) return { allowed: false };
      const result = await authority.authorize({ ...input, binding, identity: candidate });
      if (result.allowed && result.googleOrigin && options.pilotAdmission && !pilotOwner(binding)) return { allowed: false };
      const signal = live(binding);
      const identity = GoogleInferenceIdentitySchema.safeParse(candidate);
      if (result.allowed && input.phase === 'dispatch' && signal && identity.success && !input.signal.aborted) {
        sweep();
        observed.delete(binding.runtimeHandle);
        if (observed.size >= 64) observed.delete(observed.keys().next().value!);
        observed.set(binding.runtimeHandle, { binding, identity: identity.data,
          signal, expiresAt: Date.now() + 20 * 60_000 });
      }
      return result;
    },
  };
  return { contexts, inference,
    /** Server-only observation, never profile approval or a replacement for a
     * fresh credential read/revalidation before collection. No credential value. */
    observedIdentity,
    assertToolEgressAllowed: (binding: PiRuntimeBinding, signal: AbortSignal) => toolEgress.assertAllowed(binding, AbortSignal.any([signal, closing.signal])),
    /** Server-only. Caller must provide an authenticated affirmative owner interaction;
     * a model permission default is not consent. No token or credential is returned. */
    async prepareCollection(binding: PiRuntimeBinding, accountUUID: string, signal: AbortSignal,
      requestConsent: GoogleCollectionClientDependencies['requestConsent']) {
      if (closed || collections >= 32 || options.pilotAdmission && !pilotOwner(binding)) deny();
      if (collections++ === 0) collectionDrain = new Promise(resolve => { collectionsDone = resolve; });
      try {
        const collection = createGoogleCollectionClient({ registry: options.registry, contexts: collectionContexts, pins: collectionPins,
          policyClient, ownerConsentClient, resolveIdentity, requestConsent });
        return await collection.prepare(binding, accountUUID, AbortSignal.any([signal, closing.signal]));
      } finally { if (--collections === 0) { collectionsDone?.(); collectionsDone = undefined; } }
    },
    start: () => { if (!closed) pins.startCleanup(); },
    async close() {
      closed = true; closing.abort(); observed.clear();
      await collectionDrain; await databaseDrain; await pins.close();
    },
  };
}
