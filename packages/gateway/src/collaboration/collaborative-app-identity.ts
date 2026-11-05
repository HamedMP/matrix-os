import { createHash } from "node:crypto";
import { CollaborativeAppBuildRefSchema, type CollaborativeAppBuildRef } from "@matrix-os/contracts";
import { z } from "zod/v4";

import { canonicalJson } from "./direct-crypto.js";

const MAX_IDENTITY_DOCUMENT_BYTES = 256 * 1024;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const VersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const BoundedIdentityDocumentSchema = z.json().refine(
  (value) => Buffer.byteLength(canonicalJson(value), "utf8") <= MAX_IDENTITY_DOCUMENT_BYTES,
  "Identity document exceeds byte limit",
);
const CollaborativeAppIdentityInputSchema = z.object({
  appId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  catalogId: z.uuid(),
  registrationIncarnation: DigestSchema,
  manifestVersion: VersionSchema,
  manifest: BoundedIdentityDocumentSchema,
  declaredSchema: BoundedIdentityDocumentSchema,
  assetDigest: DigestSchema,
  bridgeContractVersion: VersionSchema,
  runtimeAbi: VersionSchema,
}).strict();

export type CollaborativeAppIdentityInput = z.input<typeof CollaborativeAppIdentityInputSchema>;

export class CollaborativeAppIdentityError extends Error {
  readonly code = "invalid_identity";

  constructor() {
    super("Collaborative app identity is invalid");
    this.name = "CollaborativeAppIdentityError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Build identity contains only canonical bounded inputs and is stable across ordinary restarts. */
export function createCollaborativeAppBuildIdentity(input: CollaborativeAppIdentityInput): CollaborativeAppBuildRef {
  const parsed = CollaborativeAppIdentityInputSchema.safeParse(input);
  if (!parsed.success) throw new CollaborativeAppIdentityError();
  const manifestDigest = digest(parsed.data.manifest);
  const schemaDigest = digest(parsed.data.declaredSchema);
  const buildId = digest({
    registrationIncarnation: parsed.data.registrationIncarnation,
    manifestDigest,
    schemaDigest,
    assetDigest: parsed.data.assetDigest,
    bridgeContractVersion: parsed.data.bridgeContractVersion,
    runtimeAbi: parsed.data.runtimeAbi,
  });
  return CollaborativeAppBuildRefSchema.parse({
    appId: parsed.data.appId,
    catalogId: parsed.data.catalogId,
    registrationIncarnation: parsed.data.registrationIncarnation,
    manifestVersion: parsed.data.manifestVersion,
    buildId,
    manifestDigest,
    schemaDigest,
    assetDigest: parsed.data.assetDigest,
    bridgeContractVersion: parsed.data.bridgeContractVersion,
    runtimeAbi: parsed.data.runtimeAbi,
  });
}
