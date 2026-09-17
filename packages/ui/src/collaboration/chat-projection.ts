import { CollaborationRoleSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

const SharedChatProjectionSchema = z.strictObject({
  mode: z.literal("shared"),
  membership: z.strictObject({
    role: CollaborationRoleSchema,
    memberCount: z.number().int().min(1).max(10_000),
  }),
});

export interface SharedChatMembershipProjection {
  role: "owner" | "editor" | "viewer";
  memberCount: number;
}

/** Read only the normalized server projection; incomplete data fails closed. */
export function sharedChatMembershipFromProjection(value: unknown): SharedChatMembershipProjection | null {
  const parsed = SharedChatProjectionSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    role: parsed.data.membership.role,
    memberCount: parsed.data.membership.memberCount,
  };
}
