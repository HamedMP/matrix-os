/**
 * GitHub source settings: the strict config schema, the client-safe view, and the repository identity. Pure.
 * Credentials are never part of a config: token mode reads MATRIX_BRAIN_GITHUB_TOKEN per run.
 */
import { z } from "zod/v4";
import {
  BRAIN_DATE_PATTERN, BRAIN_SOURCE_CONFIG_LIMITS, BrainFeatureError,
  type BrainGithubSourceConfig, type BrainSourceConfigView,
} from "../../contracts.js";
import { GITHUB_WEB_BASE } from "./types.js";

const SEGMENT = "[A-Za-z0-9_.-]{1,100}";
export const GITHUB_REPO_PATTERN = new RegExp(`^(${SEGMENT})/(${SEGMENT})$`);
export const GITHUB_TOKEN_ENV = "MATRIX_BRAIN_GITHUB_TOKEN";
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,255}$/;
/** 1..100 characters, no control characters, no space at either end (the integration caller's rule). */
const LABEL_PATTERN = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,98}[^\s\p{Cc}])?$/u;
const DAY_MS = 86_400_000;

function validDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value && value >= "2008-01-01";
}

export const BrainGithubConfigSchema = z.strictObject({
  repo: z.string().max(201).regex(GITHUB_REPO_PATTERN)
    .refine((repo) => repo.split("/").every((part) => part !== "." && part !== "..")),
  mode: z.enum(["integration", "token"]),
  accountLabel: z.string().max(100).regex(LABEL_PATTERN).optional(),
  include: z.strictObject({ pullRequests: z.boolean(), reviews: z.boolean(), issues: z.boolean() })
    .refine((include) => include.pullRequests || include.issues)
    .refine((include) => !include.reviews || include.pullRequests),
  since: z.string().regex(BRAIN_DATE_PATTERN).refine(validDate).optional(),
}).refine((config) => config.mode === "integration" || config.accountLabel === undefined);

/**
 * Throws BrainFeatureError("source_config_invalid"); the zod issues stay in the cause. Every field is bounded, so a
 * parsed config is far below BRAIN_SOURCE_CONFIG_LIMITS.configMaxBytes.
 */
export function parseBrainGithubConfig(raw: unknown): BrainGithubSourceConfig {
  const parsed = BrainGithubConfigSchema.safeParse(raw);
  if (!parsed.success) throw new BrainFeatureError("source_config_invalid", { cause: parsed.error });
  return parsed.data;
}

/** The repository identity in every document id: https://github.com/<owner>/<name>, lowercased (names are case-insensitive). */
export function githubExternalRef(repo: string): string {
  return `${GITHUB_WEB_BASE}/${repo.toLowerCase()}`;
}

function safeRepo(repo: string): string | null {
  return GITHUB_REPO_PATTERN.test(repo) && repo.split("/").every((part) => part !== "." && part !== "..") ? repo : null;
}

/** "owner/name" of a git source's external ref when it is a github.com web base; null otherwise. */
export function githubRepoOfWebBase(externalRef: string): string | null {
  const prefix = `${GITHUB_WEB_BASE}/`;
  return externalRef.startsWith(prefix) ? safeRepo(externalRef.slice(prefix.length)) : null;
}

/** "owner/name" of a github.com permalink such as https://github.com/<owner>/<name>/pull/12; null otherwise. */
export function githubRepoOfPermalink(permalink: string): string | null {
  const prefix = `${GITHUB_WEB_BASE}/`;
  if (!permalink.startsWith(prefix)) return null;
  const [owner, name, rest] = permalink.slice(prefix.length, prefix.length + 256).split("/", 3);
  return rest === undefined ? null : safeRepo(`${owner}/${name}`);
}

export function viewBrainGithubConfig(config: BrainGithubSourceConfig): BrainSourceConfigView {
  return {
    repo: config.repo, mode: config.mode, accountLabel: config.accountLabel ?? null,
    pullRequests: config.include.pullRequests, reviews: config.include.reviews, issues: config.include.issues,
    since: config.since ?? null,
  };
}

/** First run start: the configured day, else 365 days back, never more than the configured maximum back. */
export function initialSince(config: BrainGithubSourceConfig, now: Date): string {
  const floor = now.getTime() - BRAIN_SOURCE_CONFIG_LIMITS.githubSinceMaxDays * DAY_MS;
  const wanted = config.since !== undefined
    ? Date.parse(`${config.since}T00:00:00Z`)
    : now.getTime() - 365 * DAY_MS;
  return toGithubTime(Math.max(wanted, floor));
}

/** GitHub's second-precision UTC form: 2026-01-02T03:04:05Z. */
export function toGithubTime(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** The token for one run, or null when it is missing or not token-shaped. Never logged, stored or returned. */
export function readGithubToken(env: NodeJS.ProcessEnv): string | null {
  const token = env[GITHUB_TOKEN_ENV]?.trim();
  return token !== undefined && TOKEN_PATTERN.test(token) ? token : null;
}
