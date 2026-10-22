import type { Context } from 'hono';
import { GoogleDataRequestSchema, GoogleDataStampSchema, ResolvedGoogleRouteSchema, routeDigest,
  type GoogleDataStamp, type ResolvedGoogleRoute } from '../profiles.js';
import type { GoogleDataAuthority } from '../authority.js';
import type { GoogleDataRepository } from '../repository.js';
import { GOOGLE_PROCESSING_HEADER, verifyGoogleProcessingEnvelope, type GoogleProcessingEnvelope } from './envelope.js';

export interface GoogleCollectionAdmissionDependencies {
  repository: Pick<GoogleDataRepository, 'snapshot'>;
  authority: Pick<GoogleDataAuthority, 'assertAuthorized' | 'revalidate'>;
  ledger: { consume(envelope: GoogleProcessingEnvelope): Promise<void> };
  /** Require authenticated machine AND signed-owner context. Public owner sessions,
   * legacy unsigned delegation and request-body assertions are insufficient. */
  resolveRuntime(context: Context): Promise<{ ownerId: string; machineToken: string } | null>;
  /** Exact canonical connection UUID, active Gmail service and current owner. */
  ownsGmailAccount(ownerId: string, googleAccountId: string): Promise<boolean>;
  now?: () => Date;
}
export class GoogleCollectionAdmissionError extends Error {
  constructor() { super('Google data request unavailable'); this.name = 'GoogleCollectionAdmissionError'; }
}
function deny(): never { throw new GoogleCollectionAdmissionError(); }
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error: unknown) {
    if (error instanceof GoogleCollectionAdmissionError) throw error;
    // Dependencies may include provider/content-bearing diagnostics. Do not retain
    // a cause or log them at this boundary; callers receive only the fixed denial.
    throw new GoogleCollectionAdmissionError();
  }
}

/** Receiver of a trusted machine assertion, not remote live-run attestation.
 * Gateway composition must check its live registry/generation and durably mark
 * Google context before minting. Host account-deletion admission must cover the
 * actual operation; repeated lookups cannot atomically fence external dispatch.
 * This helper performs no collection, approves no provider and stores no body. */
export function createGoogleCollectionAdmission(deps: GoogleCollectionAdmissionDependencies) {
  const now = deps.now ?? (() => new Date());
  return {
    admit(input: { context: Context; ownerId: string; googleAccountId: string;
      path: '/call' | '/read-call'; body: string }): Promise<{ release(): Promise<void> }> {
      return guarded(async () => {
        const { context, ownerId, googleAccountId, path, body } = input;
        const signal = context.req.raw.signal;
        const key = GoogleDataRequestSchema.pick({ ownerId: true, googleAccountId: true }).safeParse({ ownerId, googleAccountId });
        if (!key.success || googleAccountId !== googleAccountId.toLowerCase()) deny();
        let envelope: GoogleProcessingEnvelope | undefined;
        let stamp: GoogleDataStamp | undefined;
        function current() {
          const at = now().getTime();
          if (signal.aborted || !Number.isSafeInteger(at) || at < 0 || envelope && (envelope.expiresAt <= at
            || Date.parse(envelope.policyExpiresAt) <= at) || stamp && Date.parse(stamp.expiresAt) <= at) deny();
          return at;
        }
        async function activeAccount() {
          current();
          const active = await deps.ownsGmailAccount(ownerId, googleAccountId);
          current();
          if (active !== true) deny();
        }
        current();
        const runtime = await deps.resolveRuntime(context);
        current();
        if (!runtime || runtime.ownerId !== ownerId) deny();
        envelope = verifyGoogleProcessingEnvelope(context.req.header(GOOGLE_PROCESSING_HEADER) ?? '', {
          ownerId, machineToken: runtime.machineToken, method: context.req.method, path, body, now: current(),
        });
        if (envelope.googleAccountId !== googleAccountId) deny();
        await activeAccount();
        const snapshot = await deps.repository.snapshot({ ownerId, googleAccountId, purposeId: envelope.purposeId, profileId: envelope.profileId });
        await activeAccount();
        const profile = snapshot.profile;
        if (!profile || profile.id !== envelope.profileId || profile.status !== 'reviewed' || profile.revision !== envelope.profileRevision
          || profile.input.ownerId !== ownerId || profile.input.purposeId !== envelope.purposeId) deny();
        const routes = profile.input.allowedModels.map(model => ResolvedGoogleRouteSchema.parse({ ...profile.input.binding, model }))
          .filter(route => routeDigest(route) === envelope!.routeDigest);
        if (routes.length !== 1) deny();
        const route: ResolvedGoogleRoute = routes[0]!;
        function matchesClaim(value: GoogleDataStamp) {
          current();
          if (value.ownerId !== ownerId || value.googleAccountId !== googleAccountId || value.purposeId !== envelope!.purposeId
            || value.profileId !== envelope!.profileId || value.profileRevision !== envelope!.profileRevision
            || value.consentId !== envelope!.consentId || value.consentRevision !== envelope!.consentRevision
            || value.routeDigest !== envelope!.routeDigest || value.expiresAt !== envelope!.policyExpiresAt) deny();
        }
        stamp = GoogleDataStampSchema.parse(await deps.authority.assertAuthorized({ ownerId, googleAccountId, purposeId: envelope.purposeId,
          profileId: profile.id, dataKinds: profile.input.dataKinds, resolvedRoute: route }));
        await activeAccount(); matchesClaim(stamp);
        const original: GoogleDataStamp = stamp;
        async function revalidate() {
          await activeAccount();
          const checked = GoogleDataStampSchema.parse(await deps.authority.revalidate(original, route));
          await activeAccount(); matchesClaim(checked);
          if (JSON.stringify(checked) !== JSON.stringify(original)) deny();
        }
        // One-use consumption follows current authority. A refusal after commit
        // intentionally burns this nonce; no collection or fresh grant follows.
        await deps.ledger.consume(envelope);
        await activeAccount();
        await revalidate();
        return { release: () => guarded(revalidate) };
      });
    },
  };
}
