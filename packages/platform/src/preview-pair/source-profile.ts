import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { PreviewPairConfigurationError, type PreviewPairConfig, type EnabledPreviewPairConfig } from "./config.js";
import { previewPairCloudResource } from "./cloud-resource.js";

const Binding = z.strictObject({ ref: z.string().max(96).regex(/^[a-z][a-z0-9-]+$/).refine(value => value.includes("preview")),
  version: z.string().max(19).regex(/^[1-9][0-9]*$/) });
const Profile = z.strictObject({ project: z.string().max(80).regex(/^[a-z][a-z0-9-]+$/),
  projectNumber: z.string().min(6).max(20).regex(/^[1-9][0-9]*$/),
  region: z.string().max(80).regex(/^[a-z][a-z0-9-]+$/), service: z.literal("matrix-platform-preview"),
  r2Prefix: z.string().max(80).regex(/^preview\/[a-z0-9-]+$/),
  activeTicketKeyId: z.string().max(80).regex(/^[A-Za-z0-9_.-]+$/),
  bindings: z.strictObject({ CLERK_SECRET_KEY: Binding, PLATFORM_DATABASE_URL: Binding,
    MATRIX_COLLABORATION_TICKET_KEYS: Binding, PLATFORM_SECRET: Binding,
    PLATFORM_JWT_SECRET: Binding, EDGE_ROUTER_SECRET: Binding }),
  imageRepository: z.string().max(63).regex(/^[a-z][a-z0-9-]+$/).refine(value => value.includes("preview")).optional(),
});
export type PreviewPairSourceProfile = z.infer<typeof Profile> & { operatorSecret: string };
export { Binding as PreviewPairSecretBindingSchema };
export type PreviewPairSecretBinding = z.infer<typeof Binding>;

/** Source-only server configuration. Resource names/versions are reviewed setup;
 * they do not prove effective IAM or grant any authority to candidate requests. */
export function loadPreviewPairSourceProfile(env: NodeJS.ProcessEnv, config: PreviewPairConfig): PreviewPairSourceProfile | undefined {
  if (!config.enabled) return undefined;
  try {
    const raw = env.MATRIX_PREVIEW_PAIR_SOURCE_PROFILE;
    if (!raw || Buffer.byteLength(raw) > 16_384 || env.MATRIX_PREVIEW_PAIR_RUNTIME_ONLY === "true") throw new PreviewPairConfigurationError();
    const profile = Profile.parse(JSON.parse(raw));
    previewPairCloudResource(profile.project, profile.region, profile.service);
    if (!config.serviceAccount.endsWith(`@${profile.project}.iam.gserviceaccount.com`)
      || profile.bindings.CLERK_SECRET_KEY.ref !== config.clerkSecretRef
      || profile.bindings.PLATFORM_DATABASE_URL.ref !== config.databaseSecretRef
      || profile.bindings.MATRIX_COLLABORATION_TICKET_KEYS.ref !== config.ticketKeysSecretRef) throw new PreviewPairConfigurationError();
    const refs = Object.values(profile.bindings).map(binding => binding.ref); // Exactly six.
    if (refs.some((ref, index) => refs.indexOf(ref) !== index)) throw new PreviewPairConfigurationError();
    const operatorSecret = z.string().min(32).max(4096).regex(/^[^\s]+$/).parse(env.MATRIX_PREVIEW_PAIR_OPERATOR_SECRET);
    if ([env.PLATFORM_SECRET, env.PLATFORM_JWT_SECRET, env.MATRIX_PREVIEW_RUNTIME_SECRET].includes(operatorSecret)) throw new PreviewPairConfigurationError();
    return { ...profile, operatorSecret };
  } catch (error: unknown) {
    if (error instanceof PreviewPairConfigurationError) throw error;
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) throw new PreviewPairConfigurationError();
    throw error;
  }
}

/** Non-authorizing public binding: private values never enter its digest. */
export function previewPairSourceFingerprint(profile: PreviewPairSourceProfile, config: EnabledPreviewPairConfig): string {
  const { operatorSecret: _operatorSecret, ...resources } = profile;
  return createHash("sha256").update(JSON.stringify({ resources, identityIssuer: config.identityIssuer,
    clerkPublishableKey: config.clerkPublishableKey, serviceAccount: config.serviceAccount, fixtures: config.fixtures })).digest("hex");
}
