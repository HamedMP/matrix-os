import { PreviewPairActorSchema, PreviewPairOrganizationSchema } from "@matrix-os/contracts/preview-pair";
import { ClerkOrganizationUpstreamClient } from "../organizations/clerk-resolver.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { PreviewPairUpstreamError } from "./http.js";

function issuer(key: string) {
  const matched = /^pk_(?:test|live)_([A-Za-z0-9_=-]{1,500})$/.exec(key);
  if (!matched) throw new PreviewPairUpstreamError();
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(matched[1], "base64"));
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,250}[a-z0-9])?\$$/.test(value) || value.includes("..")) throw new PreviewPairUpstreamError();
    return new URL(`https://${value.slice(0, -1)}`).origin;
  } catch (error: unknown) {
    if (error instanceof TypeError) throw new PreviewPairUpstreamError();
    throw error;
  }
}

/** Fresh reads from the existing organization upstream; no membership cache,
 * account store, or fallback from an unavailable lookup to an outsider denial. */
export function createPreviewPairIdentity(options: { config: EnabledPreviewPairConfig; controlSecret: string;
  previewSecret: string; controlPublishableKey: string; fetchImpl?: typeof fetch }) {
  const previewIssuer = issuer(options.config.clerkPublishableKey), controlIssuer = issuer(options.controlPublishableKey);
  if (!/^sk_test_[A-Za-z0-9_=-]{1,500}$/.test(options.previewSecret)
    || !/^sk_(?:test|live)_[A-Za-z0-9_=-]{1,500}$/.test(options.controlSecret)
    || options.previewSecret === options.controlSecret || previewIssuer === controlIssuer
    || previewIssuer !== options.config.identityIssuer) throw new PreviewPairUpstreamError();
  async function organizations(secret: string, actor: string, signal: AbortSignal) {
    signal.throwIfAborted(); PreviewPairActorSchema.parse(actor);
    try {
      const client = new ClerkOrganizationUpstreamClient({ secretKey: secret, fetchImpl: (input, init) => {
        signal.throwIfAborted();
        return (options.fetchImpl ?? fetch)(input, { ...init, cache: "no-store",
          signal: AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(10_000)]) });
      } });
      const result = await client.listOrganizationsForActor(actor);
      signal.throwIfAborted(); return result;
    } catch (error: unknown) {
      console.warn("[preview-pair] identity verification unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new PreviewPairUpstreamError();
    }
  }
  async function membership(actor: string, organization: string, signal: AbortSignal) {
    signal.throwIfAborted(); PreviewPairActorSchema.parse(actor); PreviewPairOrganizationSchema.parse(organization);
    const fixture = options.config.fixtures.find(item => item.organizationId === organization);
    if (!fixture || ![fixture.ownerActorId, fixture.memberActorId, fixture.outsiderActorId].includes(actor)) return false;
    return (await organizations(options.previewSecret, actor, signal)).includes(organization);
  }
  return {
    controlIssuer, previewIssuer,
    isMaintainer: async (actor: string) => (await organizations(options.controlSecret, actor, AbortSignal.timeout(10_000)))
      .includes(options.config.maintainerOrganizationId),
    membership,
    async verifyFixtures(signal: AbortSignal) {
      signal.throwIfAborted();
      const results = await Promise.all(options.config.fixtures.map(async fixture => {
        const [owner, member, outsider] = await Promise.all([fixture.ownerActorId, fixture.memberActorId, fixture.outsiderActorId]
          .map(actor => membership(actor, fixture.organizationId, signal)));
        return owner && member && !outsider;
      }));
      return results.every(Boolean);
    },
  };
}
