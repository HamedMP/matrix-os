import type {
  CanonicalProviderCatalog,
  OnboardingAiChoice,
  OnboardingAiProvider,
} from "@matrix-os/contracts";
import type { OnboardingAppCategory, OnboardingWidgetApp, OnboardingWidgetRepo } from "@matrix-os/ui";
import { z } from "zod/v4";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";
import { createCanonicalComposerSelection, type CanonicalComposerSelection } from "../chat/canonical-composer-state";
import type { AvailableIntegration, ConnectedIntegration } from "../integrations/types";

export const ONBOARDING_CHAT_TITLE = "Getting started";
export const ONBOARDING_MAX_APPS = 50;
export const ONBOARDING_MAX_REPOS = 20;

const DRIVER_FOR_PROVIDER: Record<OnboardingAiProvider, string> = { claude: "claude_code", codex: "codex" };
const CREDIT_STATES = new Set(["credit_required", "budget_exceeded"]);

export function onboardingSelection(catalog: CanonicalProviderCatalog, choice: OnboardingAiChoice): CanonicalComposerSelection | null {
  if (choice === "matrix") return createCanonicalComposerSelection(catalog, "hermes_default") ?? createCanonicalComposerSelection(catalog);
  const instance = catalog.instances.find((candidate) => candidate.driverKind === DRIVER_FOR_PROVIDER[choice] && candidate.availability === "available");
  return instance ? createCanonicalComposerSelection(catalog, instance.id) : null;
}

export function onboardingConnectedProviders(catalog: CanonicalProviderCatalog): OnboardingAiProvider[] {
  return (Object.keys(DRIVER_FOR_PROVIDER) as OnboardingAiProvider[]).filter((provider) =>
    catalog.instances.some((instance) => instance.driverKind === DRIVER_FOR_PROVIDER[provider] && instance.availability === "available"));
}

export function onboardingCreditsExhausted(catalog: CanonicalProviderCatalog, selection: CanonicalComposerSelection | null): boolean {
  if (!selection) return false;
  const state = catalog.instances.find((instance) => instance.id === selection.instanceId)?.connectionState;
  return state !== undefined && CREDIT_STATES.has(state);
}

const CATEGORY_BY_SERVICE: Record<string, OnboardingAppCategory> = {
  github: "dev", linear: "dev", gitlab: "dev", jira: "dev",
  gmail: "personal", google_drive: "personal", spotify: "personal", whatsapp: "personal",
};

export function onboardingApps(
  available: readonly AvailableIntegration[],
  connections: readonly ConnectedIntegration[],
  connectingService: string | null,
): OnboardingWidgetApp[] {
  const connected = new Set(connections.map((connection) => connection.service));
  return available.slice(0, ONBOARDING_MAX_APPS).map((app) => ({
    id: app.id,
    name: app.name,
    ...(app.logoUrl ? { logoUrl: app.logoUrl } : {}),
    category: CATEGORY_BY_SERVICE[app.id] ?? "work",
    status: connected.has(app.id) ? "connected" : connectingService === app.id ? "connecting" : "available",
  }));
}

const GithubReposSchema = z.object({
  repos: z.array(z.object({
    nameWithOwner: z.string().min(3).max(200),
    url: z.string().max(400),
    updatedAt: z.string().max(64).optional().nullable(),
  }).loose()).max(200),
}).loose();

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

const REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function withUpdated(repo: OnboardingWidgetRepo, iso: string | null | undefined): OnboardingWidgetRepo {
  const updatedLabel = relativeUpdatedLabel(iso);
  return updatedLabel ? { ...repo, updatedLabel } : repo;
}

async function loadComputerRepos(api: Pick<ApiClient, "get">, signal: AbortSignal): Promise<OnboardingWidgetRepo[]> {
  const raw = await api.get<unknown>(`/api/github/repos?limit=${ONBOARDING_MAX_REPOS}`, { signal, timeoutMs: 10_000, maxBytes: 256 * 1024 });
  const parsed = GithubReposSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.repos
    .filter((repo) => REPO_URL.test(repo.url))
    .slice(0, ONBOARDING_MAX_REPOS)
    .map((repo) => withUpdated({ name: repo.nameWithOwner.split("/").at(-1) ?? repo.nameWithOwner, url: repo.url }, repo.updatedAt));
}

const GithubReadReposSchema = z.object({
  data: z.array(z.object({
    name: z.string().min(1).max(100),
    html_url: z.string().max(400),
    pushed_at: z.string().max(64).optional().nullable(),
    updated_at: z.string().max(64).optional().nullable(),
  }).loose()).max(200),
}).loose();

/** Repos come from the GitHub app the user just connected; the computer's own `gh` login is only a fallback. */
export async function loadOnboardingRepos(
  api: Pick<ApiClient, "get" | "post">,
  github: { id: string; accountLabel: string } | null,
  signal: AbortSignal,
): Promise<OnboardingWidgetRepo[]> {
  if (github) {
    try {
      const raw = await api.post<unknown>("/api/integrations/read-call", {
        service: "github",
        action: "list_repos",
        label: github.accountLabel,
        connectionId: github.id,
        params: { sort: "updated", per_page: ONBOARDING_MAX_REPOS },
      }, { signal, timeoutMs: 10_000, maxBytes: 512 * 1024 });
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
  return loadComputerRepos(api, signal);
}

const VENDOR_FOR_PROVIDER: Record<OnboardingAiProvider, string> = { claude: "anthropic", codex: "openai" };
/** Sign-ins the widget can finish by polling; `browser` also needs the pasted code. `terminal` needs a Terminal tab. */
const WIDGET_SIGN_IN_METHODS = ["device_code", "existing_codex", "browser"] as const;
type WidgetSignInMethod = typeof WIDGET_SIGN_IN_METHODS[number];

interface CapabilityRow {
  harnessInstanceId: string;
  harness: string;
  connectionOptions?: ReadonlyArray<{
    id: string;
    providerId?: string;
    authKind: "subscription" | "api_key";
    method?: string;
    availability: "available" | "unavailable";
  }>;
}

export function pickProviderConnectionOption(
  rows: readonly CapabilityRow[],
  provider: OnboardingAiProvider,
  method: "account" | "api_key",
  { codeEntry = false }: { codeEntry?: boolean } = {},
): { harnessInstanceId: string; optionId: string; method?: WidgetSignInMethod } | null {
  const vendor = VENDOR_FOR_PROVIDER[provider];
  for (const row of rows) {
    if (row.harness !== provider) continue;
    const options = (row.connectionOptions ?? []).filter((candidate) => candidate.availability === "available" && candidate.providerId === vendor);
    if (method === "api_key") {
      const key = options.find((candidate) => candidate.authKind === "api_key");
      if (key) return { harnessInstanceId: row.harnessInstanceId, optionId: key.id };
      continue;
    }
    for (const signIn of WIDGET_SIGN_IN_METHODS) {
      if (signIn === "browser" && !codeEntry) continue;
      const match = options.find((candidate) => candidate.authKind === "subscription" && candidate.method === signIn);
      if (match) return { harnessInstanceId: row.harnessInstanceId, optionId: match.id, method: signIn };
    }
  }
  return null;
}

/** Network-level failures mean the computer is still waking; everything else is a real failure. */
export function isComputerStartingError(error: unknown): boolean {
  return error instanceof AppError && (error.category === "offline" || error.category === "timeout");
}

export async function admitOnboardingTurn({ client, chatId, prompt, selection }: {
  client: Pick<CanonicalChatClient, "create" | "getDetail" | "admitTurn">;
  chatId: string | null;
  prompt: string;
  selection: CanonicalComposerSelection;
}): Promise<{ chatId: string; runId: string }> {
  const modelSelection = {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options.length > 0 ? { options: selection.options } : {}),
  };
  let targetId = chatId;
  let baseRevision: number;
  if (targetId) {
    try {
      baseRevision = (await client.getDetail(targetId)).record.chat.revision;
    } catch (error: unknown) {
      if (!(error instanceof AppError && error.category === "notFound")) throw error;
      targetId = null;
      baseRevision = 0;
    }
  } else {
    baseRevision = 0;
  }
  if (!targetId) {
    const created = await client.create({ clientRequestId: canonicalChatRequestId(), title: ONBOARDING_CHAT_TITLE, currentSelection: modelSelection });
    targetId = created.chat.id;
    baseRevision = created.chat.revision;
  }
  const admitted = await client.admitTurn(targetId, {
    clientRequestId: canonicalChatRequestId(),
    baseRevision,
    parts: [{ type: "text", text: prompt }],
    selection: modelSelection,
    interactionMode: selection.interactionMode,
    permissionMode: selection.permissionMode,
  }, { chatScope: "global" });
  return { chatId: admitted.record.chat.id, runId: admitted.run.id };
}
