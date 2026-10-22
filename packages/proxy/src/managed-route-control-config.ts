import { z } from 'zod/v4';
import { CloudflareManagedGoogleRouteReviewSchema, type CloudflareManagedGoogleRouteReview } from '@matrix-os/contracts';
import type { FundedRelayConfig } from './funded-relay-config.js';

export interface ManagedRouteControlConfig { relayBaseUrl: string; reviews: readonly CloudflareManagedGoogleRouteReview[] }
export type FundedRelayServiceConfig = FundedRelayConfig & { managedRouteControl?: ManagedRouteControlConfig };
export class ManagedRouteControlConfigError extends Error {
  constructor() { super('Managed route control configuration unavailable'); this.name = 'ManagedRouteControlConfigError'; }
}
const relayUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.href.replace(/\/$/, '') === value.replace(/\/$/, ''); }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
});
const Settings = z.strictObject({ relayBaseUrl: relayUrl, reviews: z.array(CloudflareManagedGoogleRouteReviewSchema).max(16) })
  .refine(value => value.reviews.length <= 16 && new Set(value.reviews.map(review => JSON.stringify([review.relay.api, review.upstream.canonicalModelId]))).size === value.reviews.length);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export function parseManagedRouteControlConfig(value: unknown): ManagedRouteControlConfig {
  const parsed = Settings.safeParse(value); if (!parsed.success) throw new ManagedRouteControlConfigError();
  return freeze(parsed.data);
}
/** Explicit startup configuration only. Missing all settings preserves legacy service behavior. */
export function readManagedRouteControlConfig(env: NodeJS.ProcessEnv): ManagedRouteControlConfig | undefined {
  const relayBaseUrl = env.MATRIX_GOOGLE_MANAGED_ROUTE_RELAY_URL; const raw = env.MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS;
  if (relayBaseUrl === undefined && raw === undefined) return undefined;
  if (!relayBaseUrl || !raw || Buffer.byteLength(raw) > 256 * 1024) throw new ManagedRouteControlConfigError();
  let reviews: unknown;
  try { reviews = JSON.parse(raw); }
  catch (error) { if (error instanceof SyntaxError) throw new ManagedRouteControlConfigError(); throw error; }
  return parseManagedRouteControlConfig({ relayBaseUrl, reviews });
}
/** Object.freeze(Set) leaves add/delete mutable. Expose a frozen read-only facade over an unexposed copy. */
function readonlyBetas(input: ReadonlySet<string>): ReadonlySet<string> {
  if (input.size > 32) throw new ManagedRouteControlConfigError();
  const values = new Set(input);
  const view: ReadonlySet<string> = Object.freeze({ size: values.size, has: (value: string) => values.has(value),
    entries: () => values.entries(), keys: () => values.keys(), values: () => values.values(), [Symbol.iterator]: () => values.values(),
    forEach: (callback: (value: string, second: string, set: ReadonlySet<string>) => void, thisArg?: unknown) => {
      for (const value of values) callback.call(thisArg, value, value, view);
    } });
  return view;
}
/** SAME private nested snapshot is supplied to dispatch, readiness and control. No reload or public reference. */
export function snapshotFundedRelayConfig<T extends FundedRelayConfig>(input: T): T {
  const { allowedBetas, ...rest } = input;
  return freeze({ ...structuredClone(rest), allowedBetas: readonlyBetas(allowedBetas) }) as T;
}
