import { z } from "zod/v4";
import { canonicalBoundedText, canonicalOwnerRelativePath } from "#canonical-chat-primitives";
import { isCollaborationGitBranchName } from "#collaboration-execution";

/** Git metadata and server staging are never model-addressable workspace paths. */
export const GithubDeveloperPathSchema = canonicalOwnerRelativePath(256, 1024).refine(path =>
  path.split("/").length <= 16 && path.split("/").every(part => ![".git", ".bot-save", ".managed-chat-save", ".matrix-github-staging", ".artifact-recovery"].includes(part.toLowerCase()) && !part.toLowerCase().startsWith(".github-clone-")),
{ message: "Reserved workspace path" });
const RepositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)
  .refine(value => !value.endsWith(".git") && !value.includes(".."));
const BranchSchema = z.string().max(120).regex(/^matrix\/[A-Za-z0-9][A-Za-z0-9_/-]*$/)
  .refine(value => value.split("/").length <= 5 && !value.includes("//") && !value.endsWith("/") && value.split("/").every(part => part.length > 0 && !part.endsWith(".lock")));
const BaseSchema = z.string().max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
  .refine(isCollaborationGitBranchName, { message: "Invalid branch name" });
const HeadSchema = z.string().regex(/^[a-f0-9]{40}$/);
const existing = { path: GithubDeveloperPathSchema, expectedHead: HeadSchema };
export const GithubDeveloperActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), path: GithubDeveloperPathSchema.optional() }).strict(),
  z.object({ action: z.literal("clone"), repository: RepositorySchema, path: GithubDeveloperPathSchema }).strict(),
  z.object({ action: z.literal("branch"), ...existing, name: BranchSchema }).strict(),
  z.object({ action: z.literal("commit"), ...existing, files: z.array(GithubDeveloperPathSchema).min(1).max(32).refine(files => new Set(files).size === files.length), message: canonicalBoundedText(500, 2000) }).strict(),
  z.object({ action: z.literal("push"), ...existing }).strict(),
  z.object({ action: z.literal("pull_request"), ...existing, base: BaseSchema, title: canonicalBoundedText(200, 800), body: canonicalBoundedText(2000, 8000) }).strict(),
]).refine(action => JSON.stringify(action).length <= 3000, { message: "Action exceeds the exact approval preview limit" });
export type GithubDeveloperAction = z.infer<typeof GithubDeveloperActionSchema>;
