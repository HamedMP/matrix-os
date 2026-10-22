import { z } from "zod/v4";
import type { OnboardingWidgetRepo } from "../types.js";

export const ONBOARDING_MAX_REPOS = 20;

export interface OnboardingGithubReadCall {
  service: "github";
  action: "list_repos";
  label: string;
  connectionId: string;
  params: { sort: "updated"; per_page: number };
}

/** Host transport for the two repo reads; each returns the raw JSON body. */
export interface OnboardingRepoSource {
  readGithubApp(request: OnboardingGithubReadCall, signal: AbortSignal): Promise<unknown>;
  listComputerRepos(limit: number, signal: AbortSignal): Promise<unknown>;
}

const GithubReposSchema = z.object({
  repos: z.array(z.object({
    nameWithOwner: z.string().min(3).max(200),
    url: z.string().max(400),
    updatedAt: z.string().max(64).optional().nullable(),
  }).loose()).max(200),
}).loose();

const GithubReadReposSchema = z.object({
  data: z.array(z.object({
    name: z.string().min(1).max(100),
    html_url: z.string().max(400),
    pushed_at: z.string().max(64).optional().nullable(),
    updated_at: z.string().max(64).optional().nullable(),
  }).loose()).max(200),
}).loose();

const REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function relativeUpdatedLabel(iso: string | null | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

function withUpdated(repo: OnboardingWidgetRepo, iso: string | null | undefined): OnboardingWidgetRepo {
  const updatedLabel = relativeUpdatedLabel(iso);
  return updatedLabel ? { ...repo, updatedLabel } : repo;
}

async function loadComputerRepos(source: OnboardingRepoSource, signal: AbortSignal): Promise<OnboardingWidgetRepo[]> {
  const parsed = GithubReposSchema.safeParse(await source.listComputerRepos(ONBOARDING_MAX_REPOS, signal));
  if (!parsed.success) return [];
  return parsed.data.repos
    .filter((repo) => REPO_URL.test(repo.url))
    .slice(0, ONBOARDING_MAX_REPOS)
    .map((repo) => withUpdated({ name: repo.nameWithOwner.split("/").at(-1) ?? repo.nameWithOwner, url: repo.url }, repo.updatedAt));
}

/** Repos come from the GitHub app the user just connected; the computer's own `gh` login is only a fallback. */
export async function loadOnboardingRepos(
  source: OnboardingRepoSource,
  github: { id: string; accountLabel: string } | null,
  signal: AbortSignal,
): Promise<OnboardingWidgetRepo[]> {
  if (github) {
    try {
      const raw = await source.readGithubApp({
        service: "github",
        action: "list_repos",
        label: github.accountLabel,
        connectionId: github.id,
        params: { sort: "updated", per_page: ONBOARDING_MAX_REPOS },
      }, signal);
      const parsed = GithubReadReposSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data.data
          .filter((repo) => REPO_URL.test(repo.html_url))
          .slice(0, ONBOARDING_MAX_REPOS)
          .map((repo) => withUpdated({ name: repo.name, url: repo.html_url }, repo.pushed_at ?? repo.updated_at));
      }
      console.warn("[onboarding-widget] GitHub repo read returned an unexpected shape");
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      console.warn("[onboarding-widget] GitHub repo read failed:", error instanceof Error ? error.name : typeof error);
    }
  }
  return loadComputerRepos(source, signal);
}
