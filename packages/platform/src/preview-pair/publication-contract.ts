import { z } from "zod/v4";
import { PreviewPairDigestSchema, PreviewPairOriginSchema } from "@matrix-os/contracts/preview-pair";
import type { PreviewPairCloudIntentInput } from "./cloud-intents.js";

export type PreviewPairPublicationIdentity = PreviewPairCloudIntentInput;
export type PreviewPairPublicationInput = PreviewPairPublicationIdentity & { imageSha256: string };
export const PreviewPairPublicationResultSchema = z.strictObject({ publication: z.enum(["issuing", "accepted", "rejected"]),
  ready: z.boolean(), browserOrigin: PreviewPairOriginSchema.optional(), apiOrigin: PreviewPairOriginSchema.optional(),
  sourceProfileFingerprint: PreviewPairDigestSchema.optional() }).refine(value => !value.ready
    || Boolean(value.browserOrigin && value.apiOrigin && value.sourceProfileFingerprint), "Ready publication requires verified bindings");
export interface PreviewPairPublisher {
  context: { imageRepository: string; clerkPublishableKey: string };
  publish(input: PreviewPairPublicationInput, signal: AbortSignal): Promise<z.infer<typeof PreviewPairPublicationResultSchema>>;
  ready(input: PreviewPairPublicationIdentity, signal: AbortSignal): Promise<boolean>;
}
