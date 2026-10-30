import { z } from "zod/v4";
import { PREVIEW_PAIR_MAX_LIFETIME_MS, PreviewPairActorSchema, PreviewPairOrganizationSchema, PreviewPairShaSchema } from "@matrix-os/contracts/preview-pair";

const Fixture = z.strictObject({
  id: z.string().min(1).max(32).regex(/^[a-z0-9-]+$/),
  ownerActorId: PreviewPairActorSchema, memberActorId: PreviewPairActorSchema,
  outsiderActorId: PreviewPairActorSchema, organizationId: PreviewPairOrganizationSchema,
});
const SecretRef = z.string().max(96).regex(/^[a-z][a-z0-9-]+$/).refine(value => value.includes("preview"));
const Config = z.strictObject({
  controlOrigin: z.enum(["https://app.matrix-os.com", "https://api.matrix-os.com"]),
  maintainerOrganizationId: PreviewPairOrganizationSchema,
  identityIssuer: z.string().max(256).regex(/^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/),
  clerkPublishableKey: z.string().max(512).regex(/^pk_test_[A-Za-z0-9_=-]+$/),
  clerkSecretRef: SecretRef, databaseSecretRef: SecretRef, ticketKeysSecretRef: SecretRef,
  reviewedControllerSha: PreviewPairShaSchema,
  serviceAccount: z.string().max(128).regex(/^matrix-pair-preview-[a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/),
  fixtures: z.array(Fixture).min(1).max(8),
}).superRefine((config, ctx) => {
  // Input has at most eight fixtures: these transient sets have a strict size bound.
  const actors = new Set<string>(), organizations = new Set<string>(), ids = new Set<string>();
  const outsiders = new Set(config.fixtures.map(fixture => fixture.outsiderActorId));
  for (const fixture of config.fixtures) {
    if (ids.has(fixture.id) || organizations.has(fixture.organizationId)
      || fixture.ownerActorId === fixture.memberActorId
      || [fixture.ownerActorId, fixture.memberActorId].some(actor => actors.has(actor) || outsiders.has(actor))) {
      ctx.addIssue({ code: "custom", message: "Dedicated fixture inventory overlaps" });
    }
    ids.add(fixture.id); organizations.add(fixture.organizationId);
    actors.add(fixture.ownerActorId); actors.add(fixture.memberActorId);
  }
});

export class PreviewPairConfigurationError extends Error {
  constructor() { super("Preview pairs are unavailable"); this.name = "PreviewPairConfigurationError"; }
}
export type PreviewPairFixture = z.infer<typeof Fixture>;
export type EnabledPreviewPairConfig = z.infer<typeof Config> & {
  enabled: true; sourceProfileFingerprint?: string; admissionEnabled: boolean; maxActivePairs: number; maxQueued: number; maxLifetimeMs: number;
};
export type PreviewPairConfig = { enabled: false } | EnabledPreviewPairConfig;

/** Config is an activation prerequisite, not proof that live bindings match it. */
export function loadPreviewPairConfig(env: NodeJS.ProcessEnv): PreviewPairConfig {
  const flag = env.MATRIX_PREVIEW_PAIR_ENABLED;
  const maintenance = env.MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED;
  if ([flag, maintenance].some(value => value && value !== "true" && value !== "false")) throw new PreviewPairConfigurationError();
  if (flag !== "true" && maintenance !== "true") return { enabled: false };
  const raw = env.MATRIX_PREVIEW_PAIR_FIXTURES ?? "";
  if (raw.length > 64 * 1_024 || new TextEncoder().encode(raw).byteLength > 64 * 1_024) throw new PreviewPairConfigurationError();
  let fixtures: unknown;
  try { fixtures = JSON.parse(raw); }
  catch (error: unknown) { if (error instanceof SyntaxError) throw new PreviewPairConfigurationError(); throw error; }
  const parsed = Config.safeParse({
    controlOrigin: env.MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN,
    maintainerOrganizationId: env.MATRIX_PREVIEW_PAIR_MAINTAINER_ORG_ID,
    identityIssuer: env.MATRIX_PREVIEW_PAIR_IDENTITY_ISSUER,
    clerkPublishableKey: env.MATRIX_PREVIEW_PAIR_CLERK_PUBLISHABLE_KEY,
    clerkSecretRef: env.MATRIX_PREVIEW_PAIR_CLERK_SECRET_REF,
    databaseSecretRef: env.MATRIX_PREVIEW_PAIR_DATABASE_SECRET_REF,
    ticketKeysSecretRef: env.MATRIX_PREVIEW_PAIR_TICKET_KEYS_SECRET_REF,
    reviewedControllerSha: env.MATRIX_PREVIEW_PAIR_CONTROLLER_SHA,
    serviceAccount: env.MATRIX_PREVIEW_PAIR_SERVICE_ACCOUNT,
    fixtures,
  });
  if (!parsed.success) throw new PreviewPairConfigurationError();
  return { ...parsed.data, enabled: true, admissionEnabled: flag === "true", maxActivePairs: parsed.data.fixtures.length,
    maxQueued: 32, maxLifetimeMs: PREVIEW_PAIR_MAX_LIFETIME_MS };
}
