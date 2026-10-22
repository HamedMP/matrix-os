import type { ManagedGoogleRouteResolveRequest } from '@matrix-os/contracts';
import type { AiFundedControlPlaneConfig } from './ai-funded-policy-routes.js';
import { createQualifiedFundedTransactionRunner } from './ai-funded-qualified-db.js';
import { createQualifiedFundedService } from './ai-funded-qualified-service.js';
import { createFundedManagedRouteClient } from './ai-funded-managed-route-client.js';
import { installAiFundedRouteBindingSchema } from './ai-funded-route-binding.js';
import { QualifiedFundedError } from './ai-funded-qualified-errors.js';

/** Explicit operator composition. Owns only its dedicated bounded pool and services;
 * installing an additive schema never creates policy, account evidence or owner consent. */
export async function createGoogleQualifiedPlatformRuntime(options: { env: NodeJS.ProcessEnv;
  funded: AiFundedControlPlaneConfig; connectionString: string; fetchFn?: typeof fetch; now?: () => Date }) {
  const env = { ...options.env }; const flag = env.MATRIX_GOOGLE_QUALIFIED_FUNDED_ENABLED;
  if (flag === undefined || flag === 'false' || flag === '0') return undefined;
  if (flag !== 'true' || !options.funded.enabled || !options.connectionString) throw new QualifiedFundedError();
  const funded = structuredClone(options.funded);
  // Validate fixed operator endpoint/auth before allocating the private pool. Never infer from Host or caller body.
  const control = createFundedManagedRouteClient({ relayBaseUrl: env.MATRIX_FUNDED_AI_RELAY_URL ?? '',
    controlToken: funded.relayControlToken, fetchFn: options.fetchFn, now: options.now });
  const lifetime = new AbortController(); const active = new Set<AbortController>(); // <=8; finally eviction, close abort/drain.
  let closed = false; let drained = Promise.resolve(); let finish: (() => void) | undefined;
  const resolveManagedRoute = async (selector: ManagedGoogleRouteResolveRequest, parent: AbortSignal) => {
    if (closed || active.size >= 8) throw new QualifiedFundedError();
    const controller = new AbortController(); if (!active.size) drained = new Promise(resolve => { finish = resolve; }); active.add(controller);
    const signal = AbortSignal.any([parent, lifetime.signal, controller.signal]);
    try { signal.throwIfAborted(); const route = await control.resolve(selector, signal); signal.throwIfAborted(); if (closed) throw new QualifiedFundedError(); return route; }
    catch (error) { if (!(error instanceof QualifiedFundedError)) console.warn('[qualified-startup] Route unavailable'); throw new QualifiedFundedError(); }
    finally { active.delete(controller); if (!active.size) { finish?.(); finish = undefined; } }
  };
  const runner = createQualifiedFundedTransactionRunner({ connectionString: options.connectionString });
  let service: ReturnType<typeof createQualifiedFundedService> | undefined;
  try {
    await runner.run(lifetime.signal, Date.now() + 10000, tx => installAiFundedRouteBindingSchema(tx.executor));
    service = createQualifiedFundedService({ runner, platformSecret: funded.platformSecret,
      credentialHashSecret: funded.credentialHashSecret, credentialTtlMs: funded.credentialTtlMs,
      issueCooldownMs: funded.issueCooldownMs, resolveRoute: resolveManagedRoute, env, now: options.now });
    let closing: Promise<void> | undefined;
    const actualService = service;
    return Object.freeze({ service: actualService, resolveManagedRoute,
      close() {
        if (!closing) { closed = true; lifetime.abort(); for (const operation of active) operation.abort();
          closing = (async () => { try { await actualService.close(); await drained; } finally { await runner.close(); } })(); }
        return closing;
      },
    });
  } catch (error) {
    closed = true; lifetime.abort(); await service?.close(); await runner.close();
    if (!(error instanceof QualifiedFundedError)) console.warn('[qualified-startup] Initialization unavailable');
    throw new QualifiedFundedError();
  }
}
