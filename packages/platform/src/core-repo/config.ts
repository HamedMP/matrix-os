/**
 * Matrix Core repo configuration (spec 2691, layer 6). Platform-only: the
 * GitHub App key and webhook secret never leave this process. Any missing or
 * invalid value turns the feature off; nothing is partially enabled.
 *
 * The org ↔ installation/repository mapping is operator-reviewed config
 * (`MATRIX_CORE_REPO_SOURCES`). Self-serve binding needs a GitHub user check
 * that the admin controls the installation, and is deferred.
 */
import { createPrivateKey } from "node:crypto";
import { CORE_REPO_DEFAULT_REF, CoreRepoOrgIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

const SourceSchema = z.object({
  orgId: CoreRepoOrgIdSchema,
  installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).refine(value => value.split("/").every(part => !/^\.+$/.test(part))),
  ref: z.string().regex(/^[A-Za-z0-9_.\/-]{1,100}$/).refine(value => !value.includes("..")).default(CORE_REPO_DEFAULT_REF),
}).strict();
export type CoreRepoSource = z.infer<typeof SourceSchema>;

export interface CoreRepoConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  sources: CoreRepoSource[];
}

export function parseCoreRepoConfig(env: NodeJS.ProcessEnv): CoreRepoConfig | null {
  const appId = env.MATRIX_CORE_REPO_GITHUB_APP_ID?.trim();
  const privateKey = env.MATRIX_CORE_REPO_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const webhookSecret = env.MATRIX_CORE_REPO_GITHUB_WEBHOOK_SECRET;
  const rawSources = env.MATRIX_CORE_REPO_SOURCES;
  if (!appId || !privateKey || !webhookSecret || !rawSources) return null;
  if (!/^[0-9]{1,20}$/.test(appId) || webhookSecret.length < 32) {
    console.warn("[core-repo] configuration rejected: app id or webhook secret is invalid");
    return null;
  }
  try {
    createPrivateKey(privateKey);
  } catch (error: unknown) {
    console.warn("[core-repo] configuration rejected: GitHub App private key is invalid", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawSources) as unknown; }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn("[core-repo] configuration rejected: MATRIX_CORE_REPO_SOURCES is not JSON");
    return null;
  }
  const sources = z.array(SourceSchema).min(1).max(500).safeParse(parsed);
  if (!sources.success || new Set(sources.data.map(source => source.orgId)).size !== sources.data.length) {
    console.warn("[core-repo] configuration rejected: MATRIX_CORE_REPO_SOURCES is invalid");
    return null;
  }
  return { appId, privateKey, webhookSecret, sources: sources.data };
}
