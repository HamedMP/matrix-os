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

export async function loadOnboardingRepos(api: Pick<ApiClient, "get">, signal: AbortSignal): Promise<OnboardingWidgetRepo[]> {
  const raw = await api.get<unknown>(`/api/github/repos?limit=${ONBOARDING_MAX_REPOS}`, { signal, timeoutMs: 10_000, maxBytes: 256 * 1024 });
  const parsed = GithubReposSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.repos
    .filter((repo) => /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo.url))
    .slice(0, ONBOARDING_MAX_REPOS)
    .map((repo) => ({
      name: repo.nameWithOwner.split("/").at(-1) ?? repo.nameWithOwner,
      url: repo.url,
      ...(relativeUpdatedLabel(repo.updatedAt) ? { updatedLabel: relativeUpdatedLabel(repo.updatedAt) } : {}),
    }));
}

interface CapabilityRow {
  harnessInstanceId: string;
  harness: string;
  connectionOptions?: ReadonlyArray<{ id: string; authKind: "subscription" | "api_key"; availability: "available" | "unavailable" }>;
}

export function pickProviderConnectionOption(
  rows: readonly CapabilityRow[],
  provider: OnboardingAiProvider,
  method: "account" | "api_key",
): { harnessInstanceId: string; optionId: string } | null {
  const authKind = method === "account" ? "subscription" : "api_key";
  for (const row of rows) {
    if (row.harness !== provider) continue;
    const option = row.connectionOptions?.find((candidate) => candidate.authKind === authKind && candidate.availability === "available");
    if (option) return { harnessInstanceId: row.harnessInstanceId, optionId: option.id };
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
