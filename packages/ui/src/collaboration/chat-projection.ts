import { CollaborationIdSchema, CollaborationRoleSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

const SharedChatProjectionSchema = z.looseObject({
  mode: z.literal("shared"),
  scopeId: CollaborationIdSchema,
  membership: z.looseObject({
    role: CollaborationRoleSchema,
    memberCount: z.number().int().min(1).max(10_000),
    capabilities: z.looseObject({ requestAi: z.boolean() }),
  }),
});

export interface SharedChatProjection {
  scopeId: string;
  role: "owner" | "editor" | "viewer";
  memberCount: number;
  requestAi: boolean;
}

/** Read only the normalized server projection; incomplete data fails closed. */
export function sharedChatScopeFromProjection(value: unknown): SharedChatProjection | null {
  const parsed = SharedChatProjectionSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    scopeId: parsed.data.scopeId,
    role: parsed.data.membership.role,
    memberCount: parsed.data.membership.memberCount,
    requestAi: parsed.data.membership.capabilities.requestAi,
  };
}
