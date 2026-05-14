import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX } from "../project-manager.js";

export const BOARD_MEMBER_LIMIT = 100;
export const BOARD_BODY_LIMIT = 16 * 1024;
export const BoardProjectSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
export const BoardUserIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@-]+$/);
export const BoardMemberRoleSchema = z.enum(["viewer", "editor", "owner"]);
export const AddBoardMemberSchema = z.object({
  userId: BoardUserIdSchema,
  role: z.enum(["viewer", "editor"]),
});
export const BoardMemberSchema = z.object({
  projectSlug: BoardProjectSlugSchema,
  userId: BoardUserIdSchema,
  role: BoardMemberRoleSchema,
  addedBy: BoardUserIdSchema,
  addedAt: z.string(),
});

export type BoardMemberRole = z.infer<typeof BoardMemberRoleSchema>;
export type AddBoardMemberInput = z.infer<typeof AddBoardMemberSchema>;
export type BoardMember = z.infer<typeof BoardMemberSchema>;

export function boardError(code: string, message: string) {
  return { error: { code, message } };
}
