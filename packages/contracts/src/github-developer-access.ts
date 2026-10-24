import { z } from "zod/v4";

export const GITHUB_DEVELOPER_LOGIN_COMMAND = "matrix-github-developer-login" as const;

export const GithubDeveloperStatusErrorCodeSchema = z.enum([
  "gh_missing",
  "github_auth_required",
  "github_status_unavailable",
  "github_ssh_setup_required",
  "github_ssh_unavailable",
  "git_identity_missing",
  "git_identity_unavailable",
]);

export const GithubDeveloperStatusSchema = z.object({
  installed: z.boolean(),
  authenticated: z.boolean(),
  user: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/).nullable(),
  gitProtocol: z.enum(["ssh", "https"]).nullable(),
  sshStatus: z.enum(["verified", "setup_required", "unavailable"]),
  commitIdentity: z.object({
    status: z.enum(["ready", "missing", "unavailable"]),
    label: z.string().min(5).max(525).nullable(),
  }).strict(),
  ready: z.boolean(),
  errorCode: GithubDeveloperStatusErrorCodeSchema.nullable(),
}).strict();

export type GithubDeveloperStatus = z.infer<typeof GithubDeveloperStatusSchema>;
export type GithubDeveloperStatusErrorCode = z.infer<typeof GithubDeveloperStatusErrorCodeSchema>;

