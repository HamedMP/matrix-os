import type {
  AvailableIntegration,
  CanonicalProviderCatalog,
  ConnectedIntegration,
  OnboardingAiChoice,
  OnboardingAiProvider,
} from "@matrix-os/contracts";
import { createCanonicalComposerSelection, type CanonicalComposerSelection } from "../../canonical-composer-selection.js";
import type { OnboardingAppCategory, OnboardingWidgetApp } from "../types.js";

export const ONBOARDING_MAX_APPS = 50;

const DRIVER_FOR_PROVIDER: Record<OnboardingAiProvider, string> = { claude: "claude_code", codex: "codex" };
const MATRIX_AI_INSTANCES = ["hermes_default", "matrix_pi_default"];
const CREDIT_STATES = new Set(["credit_required", "budget_exceeded"]);

/** A route for exactly the chosen AI, or null; never whatever else the catalog would default to. */
export function onboardingSelection(catalog: CanonicalProviderCatalog, choice: OnboardingAiChoice): CanonicalComposerSelection | null {
  const ids = choice === "matrix"
    ? MATRIX_AI_INSTANCES
    : catalog.instances.filter((instance) => instance.driverKind === DRIVER_FOR_PROVIDER[choice]).map((instance) => instance.id);
  for (const id of ids) {
    const selection = createCanonicalComposerSelection(catalog, id);
    if (selection?.instanceId === id) return selection;
  }
  return null;
}

/** How each connected provider is reached, as Chat's picker names it ("Anthropic API key", "Claude subscription"). */
export function onboardingConnectionLabels(catalog: CanonicalProviderCatalog): Partial<Record<OnboardingAiProvider, string>> {
  const labels: Partial<Record<OnboardingAiProvider, string>> = {};
  for (const provider of Object.keys(DRIVER_FOR_PROVIDER) as OnboardingAiProvider[]) {
    const label = catalog.instances.find((instance) => instance.driverKind === DRIVER_FOR_PROVIDER[provider]
      && instance.availability === "available" && instance.connectionLabel)?.connectionLabel;
    if (label) labels[provider] = label;
  }
  return labels;
}

/** The model and connection a provider's tasks run on, e.g. "Claude Opus 5.5 · Anthropic API key".
 * Null for Matrix AI and for a provider that cannot run, which keep their existing wording. */
export function onboardingAiDetail(catalog: CanonicalProviderCatalog, choice: OnboardingAiChoice): string | null {
  if (choice === "matrix") return null;
  const selection = onboardingSelection(catalog, choice);
  const instance = selection && catalog.instances.find((item) => item.id === selection.instanceId);
  if (!selection || instance?.availability !== "available") return null;
  const modelName = instance.models.find((model) => model.id === selection.model)?.displayName;
  // Chat names an alias "Default · currently Claude Opus 5.5"; the widget shows only the concrete model.
  const model = modelName ? modelName.split(" · currently ").pop() ?? modelName : null;
  const parts = [model, instance.connectionLabel].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Which of the widget's AIs a provider instance is, to name it; null for one the widget does not offer. */
export function onboardingAiForInstance(catalog: CanonicalProviderCatalog, instanceId: string): OnboardingAiChoice | null {
  if (MATRIX_AI_INSTANCES.includes(instanceId)) return "matrix";
  const driverKind = catalog.instances.find((instance) => instance.id === instanceId)?.driverKind;
  return (Object.keys(DRIVER_FOR_PROVIDER) as OnboardingAiProvider[]).find((provider) => DRIVER_FOR_PROVIDER[provider] === driverKind) ?? null;
}

export function onboardingConnectedProviders(catalog: CanonicalProviderCatalog): OnboardingAiProvider[] {
  return (Object.keys(DRIVER_FOR_PROVIDER) as OnboardingAiProvider[]).filter((provider) =>
    catalog.instances.some((instance) => instance.driverKind === DRIVER_FOR_PROVIDER[provider] && instance.availability === "available"));
}

/** The AI a new task runs on: the saved choice, or a connected AI while Matrix AI can't run on this computer. */
export function onboardingActiveAi(catalog: CanonicalProviderCatalog, choice: OnboardingAiChoice): OnboardingAiChoice {
  if (choice !== "matrix" || onboardingSelection(catalog, "matrix")) return choice;
  return onboardingConnectedProviders(catalog).find((provider) => onboardingSelection(catalog, provider)) ?? "matrix";
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
  const connected = new Set(connections.filter((connection) => connection.status === "active").map((connection) => connection.service));
  return available.slice(0, ONBOARDING_MAX_APPS).map((app) => ({
    id: app.id,
    name: app.name,
    ...(app.logoUrl ? { logoUrl: app.logoUrl } : {}),
    category: CATEGORY_BY_SERVICE[app.id] ?? "work",
    status: connected.has(app.id) ? "connected" : connectingService === app.id ? "connecting" : "available",
  }));
}

const VENDOR_FOR_PROVIDER: Record<OnboardingAiProvider, string> = { claude: "anthropic", codex: "openai" };
/** Sign-ins the widget can finish by polling; `browser` also needs the pasted code. `terminal` needs a Terminal tab. */
const WIDGET_SIGN_IN_METHODS = ["device_code", "existing_codex", "browser"] as const;
export type OnboardingSignInMethod = typeof WIDGET_SIGN_IN_METHODS[number];

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
): { harnessInstanceId: string; optionId: string; method?: OnboardingSignInMethod } | null {
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
