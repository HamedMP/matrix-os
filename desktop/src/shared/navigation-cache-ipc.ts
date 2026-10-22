import { z } from "zod/v4";
import { CanonicalChatNavigationResponseSchema } from "@matrix-os/contracts";
const Scope = z.string().regex(/^[a-f0-9]{64}$/);
const Fence = z.strictObject({
  scope: Scope, authGeneration: z.number().int().nonnegative()
});
export const NAVIGATION_CACHE_INVOKE = {
  "navigation-cache:context": {
    request: z.strictObject({}), response: z.strictObject({
      scope: Scope.nullable(), authGeneration: z.number().int().nonnegative()
    })
  },
  "navigation-cache:load": {
    request: Fence, response: z.strictObject({
      snapshot: CanonicalChatNavigationResponseSchema.nullable()
    })
  },
  "navigation-cache:save": {
    request: Fence.extend({
      snapshot: CanonicalChatNavigationResponseSchema
    }).strict(), response: z.strictObject({
      ok: z.boolean()
    })
  },
  "navigation-cache:clear": {
    request: Fence, response: z.strictObject({
      ok: z.boolean()
    })
  },
} as const;
export type NavigationCacheFence = z.infer<typeof Fence>;
