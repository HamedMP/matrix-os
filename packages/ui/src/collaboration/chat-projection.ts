import { CollaborationRoleSchema, CollaborationSharedChatMessageSchema } from "@matrix-os/contracts";
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

export interface NativeSharedChatMessage {
  id: string;
  sequence: string;
  side: "human" | "ai";
  role: "user" | "assistant" | "tool" | "system";
  state: "pending" | "committed" | "failed";
  parts: z.infer<typeof CollaborationSharedChatMessageSchema>["parts"];
  attribution?: { actorId: string; displayName: string };
  createdAt: string;
}

/** Projects canonical shared history into the ordinary Chat timeline. */
export function projectSharedChatTimeline(
  messages: readonly z.infer<typeof CollaborationSharedChatMessageSchema>[],
): NativeSharedChatMessage[] {
  return messages
    .filter((message) => message.purpose !== "discussion")
    .map((message) => ({
      id: message.id,
      sequence: message.sequence,
      side: message.role === "user" ? "human" as const : "ai" as const,
      role: message.role,
      state: message.state,
      parts: message.parts,
      ...(message.role === "user" ? { attribution: message.actor } : {}),
      createdAt: message.createdAt,
    }));
}
