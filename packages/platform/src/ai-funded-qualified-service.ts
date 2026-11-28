import { randomUUID } from 'node:crypto';
import { AiFundedPolicyError } from './ai-funded-policy-errors.js';
import { createFundedAuthorize } from './ai-funded-authorization.js';
import { admitQualifiedFundedRoute } from './ai-funded-qualified-admission.js';
import { sql } from 'kysely';
import { GoogleQualifiedFundedDiscoveryRequestSchema, GoogleQualifiedFundedDiscoveryResponseSchema, GoogleQualifiedFundedIssueRequestSchema,
  GoogleQualifiedFundedIssueResponseSchema, GoogleQualifiedFundedCheckRequestSchema, GoogleQualifiedFundedCheckResponseSchema,
  GoogleQualifiedFundedAuthorizationRequestSchema, GoogleQualifiedFundedAuthorizationResponseSchema, GoogleQualifiedFundedDispatchCheckRequestSchema, GoogleQualifiedFundedDispatchCheckResponseSchema, parseGoogleQualifiedFundedCredential,
  GoogleQualifiedFundedRouteSchema, GOOGLE_QUALIFIED_FUNDED_PROTOCOL, type GoogleQualifiedFundedRoute, type ManagedGoogleRouteResolveRequest } from '@matrix-os/contracts';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { googleQualifiedRouteDigest } from './ai-funded-route-binding.js';
import { authenticateQualifiedMachine, sameQualifiedMachine, qualifiedPolicy, mintQualifiedToken,
  qualifiedTokenHash, type QualifiedRuntimeAuth } from './ai-funded-qualified-state.js';
import type { QualifiedFundedTransactionRunner } from './ai-funded-qualified-db.js';
import { assertQualifiedLive, QualifiedFundedError } from './ai-funded-qualified-errors.js';

/** Optional composition only. No schema installation, approvals, registration or shared-pool ownership. */
export function createQualifiedFundedService(options: { runner: QualifiedFundedTransactionRunner; platformSecret: string; credentialHashSecret: string;
  resolveRoute: (selector: ManagedGoogleRouteResolveRequest, signal: AbortSignal) => Promise<GoogleQualifiedFundedRoute>;
  now?: () => Date; credentialTtlMs?: number; issueCooldownMs?: number; env?: NodeJS.ProcessEnv }) {
  const ttlMs = options.credentialTtlMs ?? 900000; const cooldownMs = options.issueCooldownMs ?? 30000; const now = options.now ?? (() => new Date());
  if (options.platformSecret.length < 32 || options.credentialHashSecret.length < 32 || options.platformSecret === options.credentialHashSecret
    || !Number.isInteger(ttlMs) || ttlMs < 60000 || ttlMs > 3600000 || !Number.isInteger(cooldownMs) || cooldownMs < 1000 || cooldownMs > ttlMs) throw new QualifiedFundedError();
  const active = new Set<AbortController>(); // <=8 whole requests, evicted in finally; shutdown abort/drain.
  let closed = false; let drained = Promise.resolve(); let finish: (() => void) | undefined;
  async function bounded<T>(parent: AbortSignal, work: (signal: AbortSignal, deadline: number) => Promise<T>): Promise<T> {
    if (closed || active.size >= 8) throw new QualifiedFundedError();
    const controller = new AbortController(); if (!active.size) drained = new Promise(resolve => { finish = resolve; }); active.add(controller);
    const deadline = Date.now() + 10000; const timer = setTimeout(() => controller.abort(), 10000); timer.unref?.();
    const signal = AbortSignal.any([parent, controller.signal]);
    try { assertQualifiedLive(signal, deadline); const value = await work(signal, deadline); assertQualifiedLive(signal, deadline); return value; }
    catch (error) { if (error instanceof QualifiedFundedError) throw error; console.warn('[qualified-funded] Operation unavailable'); throw new QualifiedFundedError(); }
    finally { clearTimeout(timer); active.delete(controller); if (!active.size) { finish?.(); finish = undefined; } }
  }
  async function resolve(selector: ManagedGoogleRouteResolveRequest, signal: AbortSignal, deadline: number) {
    const result = GoogleQualifiedFundedRouteSchema.parse(await options.resolveRoute({ api: selector.api, canonicalModelId: selector.canonicalModelId } as ManagedGoogleRouteResolveRequest, signal));
    assertQualifiedLive(signal, deadline); const at = now().getTime();
    if (result.api !== selector.api || result.canonicalModelId !== selector.canonicalModelId || googleQualifiedRouteDigest(result.descriptor) !== result.digest
      || at < Date.parse(result.descriptor.evidence.reviewedAt) || at >= Date.parse(result.evidenceExpiresAt)) throw new QualifiedFundedError();
    return result;
  }
  const authenticate = (auth: QualifiedRuntimeAuth, signal: AbortSignal) => bounded(signal, (current, deadline) =>
    options.runner.run(current, deadline, tx => authenticateQualifiedMachine(tx, auth, options.platformSecret)));
  return {
    requestScope<T>(signal: AbortSignal, work: (current: AbortSignal) => Promise<T>) { return bounded(signal, current => work(current)); },
    authenticate,
    discover(auth: QualifiedRuntimeAuth, input: unknown, parent: AbortSignal) { return bounded(parent, async (signal, deadline) => {
      const request = GoogleQualifiedFundedDiscoveryRequestSchema.parse(input);
      const initial = await options.runner.run(signal, deadline, tx => authenticateQualifiedMachine(tx, auth, options.platformSecret));
      const route = await resolve(request, signal, deadline);
      await options.runner.run(signal, deadline, async tx => {
        const current = await authenticateQualifiedMachine(tx, auth, options.platformSecret, true); if (!sameQualifiedMachine(initial, current)) throw new QualifiedFundedError();
        await qualifiedPolicy(tx, current, route.canonicalModelId, now());
      });
      return GoogleQualifiedFundedDiscoveryResponseSchema.parse({ protocol: GOOGLE_QUALIFIED_FUNDED_PROTOCOL, route });
    }); },
    issue(auth: QualifiedRuntimeAuth, input: unknown, parent: AbortSignal) { return bounded(parent, async (signal, deadline) => {
      const request = GoogleQualifiedFundedIssueRequestSchema.parse(input);
      const initial = await options.runner.run(signal, deadline, tx => authenticateQualifiedMachine(tx, auth, options.platformSecret));
      const route = await resolve(request, signal, deadline); if (route.digest !== request.expectedDigest) throw new QualifiedFundedError();
      return options.runner.run(signal, deadline, tx => withAccountDeletionOwnerLock(tx, initial.ownerId, async (admitted, admission) => {
        if (!admission.newWorkAllowed) throw new QualifiedFundedError();
        await sql`select pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${initial.ownerId}`}, 0))`.execute(admitted.executor);
        const current = await authenticateQualifiedMachine(admitted, auth, options.platformSecret, true);
        if (!sameQualifiedMachine(initial, current)) throw new QualifiedFundedError();
        const policy = await qualifiedPolicy(admitted, current, route.canonicalModelId, now()); assertQualifiedLive(signal, deadline);
        const issued = await mintQualifiedToken(admitted, { machine: current, route, requestClass: request.requestClass, policy,
          now, hashSecret: options.credentialHashSecret, ttlMs, cooldownMs });
        assertQualifiedLive(signal, deadline);
        return GoogleQualifiedFundedIssueResponseSchema.parse({ protocol: GOOGLE_QUALIFIED_FUNDED_PROTOCOL, ...issued });
      }, options.env));
    }); },
    check(input: unknown, parent: AbortSignal) { return bounded(parent, async (signal, deadline) => {
      const request = GoogleQualifiedFundedCheckRequestSchema.parse(input);
      if (request.api !== 'openai-completions') throw new QualifiedFundedError();
      const api = request.api; const canonicalModelId = request.canonicalModelId;
      const selector = GoogleQualifiedFundedDispatchCheckRequestSchema.parse({ protocol: request.protocol, credential: request.credential, api,
        canonicalModelId, expectedDigest: request.expectedDigest });
      async function snapshot() { const result = await options.runner.run(signal, deadline, tx => admitQualifiedFundedRoute(tx, selector,
        { hashSecret: options.credentialHashSecret, now, env: options.env }));
        if (result.binding.requestClass !== request.requestClass) throw new QualifiedFundedError(); return result; }
      const first = await snapshot(); const actual = await resolve(request, signal, deadline);
      if (actual.digest !== first.binding.digest) throw new QualifiedFundedError();
      const current = await snapshot();
      if (JSON.stringify(current.binding) !== JSON.stringify(first.binding)) throw new QualifiedFundedError();
      return GoogleQualifiedFundedCheckResponseSchema.parse({ protocol: GOOGLE_QUALIFIED_FUNDED_PROTOCOL, ...current });
    }); },
    /** Only the service-control-authenticated proxy may assert its freshly recomputed dispatch digest.
     * No recursive control lookup: the proxy checks its own immutable actual config before and after this await. */
    dispatchCheck(input: unknown, parent: AbortSignal) { return bounded(parent, async (signal, deadline) => {
      const request = GoogleQualifiedFundedDispatchCheckRequestSchema.parse(input);
      const current = await options.runner.run(signal, deadline, tx => admitQualifiedFundedRoute(tx, request,
        { hashSecret: options.credentialHashSecret, now, env: options.env }));
      return GoogleQualifiedFundedDispatchCheckResponseSchema.parse({ protocol: GOOGLE_QUALIFIED_FUNDED_PROTOCOL, ...current });
    }); },
    authorize(input: unknown, parent: AbortSignal) { return bounded(parent, async (signal, deadline) => {
      const request = GoogleQualifiedFundedAuthorizationRequestSchema.parse(input);
      const selector = GoogleQualifiedFundedDispatchCheckRequestSchema.parse({ protocol: request.protocol, credential: request.credential,
        api: request.api, canonicalModelId: request.canonicalModelId, expectedDigest: request.expectedDigest });
      const initial = await options.runner.run(signal, deadline, tx => admitQualifiedFundedRoute(tx, selector,
        { hashSecret: options.credentialHashSecret, now, env: options.env }));
      const actual = await resolve(request, signal, deadline); if (actual.digest !== initial.binding.digest) throw new QualifiedFundedError();
      const outcome = await options.runner.run(signal, deadline, async tx => {
        const current = await admitQualifiedFundedRoute(tx, selector, { hashSecret: options.credentialHashSecret, now, env: options.env });
        if (JSON.stringify(initial.binding) !== JSON.stringify(current.binding)) throw new QualifiedFundedError();
        const authorize = createFundedAuthorize({ db: tx, now, hashCredential: token => qualifiedTokenHash(token, options.credentialHashSecret),
          reservationIdFactory: randomUUID, reservationTtlMs: 30000, policyFreshnessMs: 1000,
          protocol: { decode() { const tokenId = parseGoogleQualifiedFundedCredential(request.credential)?.tokenId; if (!tokenId) throw new QualifiedFundedError();
            return { tokenId, routeDigest: current.binding.digest, request: { credential: request.credential, requestId: request.requestId,
              modelId: current.binding.canonicalModelId, maxCostMicrousd: request.maxCostMicrousd, billingMode: request.billingMode,
              ...(request.claimKey ? { claimKey: request.claimKey } : {}) } }; } } });
        let authorization: Awaited<ReturnType<typeof authorize>> | undefined;
        let rejection: AiFundedPolicyError | undefined;
        try {
          authorization = await authorize({ credential: request.credential, requestId: request.requestId,
            modelId: request.canonicalModelId, maxCostMicrousd: request.maxCostMicrousd, billingMode: request.billingMode });
        } catch (error: unknown) {
          // The nested authorizer may have persisted a waiting claim. Only its
          // typed priority refusal may cross this outer transaction as a value.
          if (error instanceof AiFundedPolicyError && error.code === 'rate_limited'
            && ['slot_busy', 'priority_queue', 'priority_hold', 'priority_full'].includes(error.reason ?? '')) rejection = error;
          else throw error;
        }
        assertQualifiedLive(signal, deadline);
        const final = await admitQualifiedFundedRoute(tx, selector, { hashSecret: options.credentialHashSecret, now, env: options.env });
        if (JSON.stringify(final.binding) !== JSON.stringify(current.binding)) throw new QualifiedFundedError();
        if (rejection) return { kind: 'priority-rejected' as const, rejection };
        if (!authorization) throw new QualifiedFundedError();
        return { kind: 'authorized' as const, response: GoogleQualifiedFundedAuthorizationResponseSchema.parse({ protocol: GOOGLE_QUALIFIED_FUNDED_PROTOCOL, authorization, binding: current.binding }) };
      });
      // Commit the claim before reporting refusal; database/admission failures
      // still throw inside the transaction and roll all related writes back.
      if (outcome.kind === 'priority-rejected') throw outcome.rejection;
      return outcome.response;
    }); },
    async close() { closed = true; for (const operation of active) operation.abort(); await drained; },
  };
}
export type QualifiedFundedService = ReturnType<typeof createQualifiedFundedService>;
