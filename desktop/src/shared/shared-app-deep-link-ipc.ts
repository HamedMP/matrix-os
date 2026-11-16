import { z } from "zod/v4";
import { SharedAppLinkSchema } from "@matrix-os/contracts";

/** Target of `matrixos://shared-app/<scopeId>?…` (spec 2693 phase 4). Display hints never cross IPC. */
export const SharedAppDeepLinkSchema = SharedAppLinkSchema.omit({ app: true, org: true });
export type SharedAppDeepLink = z.infer<typeof SharedAppDeepLinkSchema>;

export const SHARED_APP_DEEP_LINK_EVENTS = {
  "deeplink:shared-app": SharedAppDeepLinkSchema,
} as const;

export const SHARED_APP_DEEP_LINK_INVOKE = {
  /** The renderer pulls a link that arrived before it could listen (cold start). */
  "deeplink:take-shared-app": {
    request: z.strictObject({}),
    response: z.strictObject({ link: SharedAppDeepLinkSchema.nullable() }),
  },
} as const;
