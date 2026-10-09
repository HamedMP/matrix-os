import {
  canonicalProviderAvailabilityReasonLabel,
  canonicalProviderFundingState,
  canonicalProviderModelRouteLabel,
  isLegacyMatrixSdkProvider,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

import type { Provider } from "@/components/ui";

type Catalog = CanonicalProviderCatalog | null;
type Selection = CanonicalChatModelSelection | null;
type ProviderInstance = CanonicalProviderCatalog["instances"][number];
type ProviderModel = ProviderInstance["models"][number];

const MODEL_VALUE_SEPARATOR = "::";
export const MATRIX_ENGINE_ID = "matrix-ai";

// Matrix's own routes carry the Matrix mark; an agent engine carries its own.
const ENGINE_LOGO: Record<ProviderInstance["driverKind"], Provider> = {
  kernel: "matrix",
  matrix_pi: "matrix",
  matrix_bot: "matrix",
  claude_code: "claude",
  codex: "codex",
  hermes: "hermes",
  openclaw: "openclaw",
  opencode: "opencode",
  pi: "pi",
};

export interface ModelChoice {
  key: string;
  name: string;
  /** The route the model runs through, then why it cannot run when it cannot. */
  detail: string;
  logo: Provider;
  selected: boolean;
  available: boolean;
}

export interface ModelEngine {
  id: string;
  label: string;
  logo: Provider;
  models: ModelChoice[];
  /** Why nothing in the engine can run. Null when something can. */
  note: string | null;
}

export interface ModelNote {
  key: string;
  text: string;
}

export function modelKey(instanceId: string, modelId: string): string {
  return `${instanceId}${MODEL_VALUE_SEPARATOR}${modelId}`;
}

function joined(...parts: (string | null)[]): string {
  return parts.filter(Boolean).join(" · ");
}

/** The route's name without the model's: "Matrix AI" out of "Sonnet 5 · Matrix AI". */
function routeName(instance: ProviderInstance | undefined, modelLabel: string): string {
  const prefix = `${modelLabel} · `;
  const route = canonicalProviderModelRouteLabel(instance, modelLabel);
  return route.startsWith(prefix) ? route.slice(prefix.length) : "";
}

/** Every engine entry of the catalog but the retired Matrix SDK route. */
function offered(catalog: Catalog): ProviderInstance[] {
  return catalog?.instances.filter((instance) => !isLegacyMatrixSdkProvider(instance)) ?? [];
}

function canRun(instance: ProviderInstance, model: ProviderModel): boolean {
  return instance.availability === "available" && model.availability === "available";
}

function creditReserved(instance: ProviderInstance): boolean {
  return canonicalProviderFundingState(instance) === "credit_reserved";
}

function blockedReason(instance: ProviderInstance, model: ProviderModel): string | null {
  if (canRun(instance, model)) return null;
  if (creditReserved(instance)) return "Credit reserved";
  if (instance.availability === "available") return "Model unavailable";
  return canonicalProviderAvailabilityReasonLabel(instance);
}

function engineIdOf(instance: ProviderInstance): string {
  return ENGINE_LOGO[instance.driverKind] === "matrix" ? MATRIX_ENGINE_ID : instance.id;
}

/** What the catalog says about the saved selection. */
function savedSelection(catalog: Catalog, selection: Selection) {
  const instance = selection ? catalog?.instances.find((candidate) => candidate.id === selection.instanceId) : undefined;
  const model = instance?.models.find((candidate) => candidate.id === selection?.model);
  const listed = instance !== undefined && model !== undefined && !isLegacyMatrixSdkProvider(instance);
  const available = listed && canRun(instance, model);
  return {
    key: selection ? modelKey(selection.instanceId, selection.model) : null,
    instance,
    model,
    available,
    modelLabel: model?.displayName ?? selection?.model ?? "Models unavailable",
    // A saved model whose credit is held is listed as held instead.
    state: available || (listed && creditReserved(instance)) ? null : catalog ? "unavailable" : "checking",
  };
}

/**
 * A saved model the engine no longer lists. It keeps its place, checked, so
 * its identity is not lost, but it cannot be chosen.
 */
function lostChoice(saved: ReturnType<typeof savedSelection>, engineId: string, listed: ModelChoice[]): ModelChoice[] {
  if (!saved.key || !saved.instance || !saved.state) return [];
  if (engineIdOf(saved.instance) !== engineId || listed.some((model) => model.key === saved.key)) return [];
  return [{
    key: saved.key,
    name: saved.modelLabel,
    detail: joined(routeName(saved.instance, saved.modelLabel), saved.state),
    logo: ENGINE_LOGO[saved.instance.driverKind],
    selected: true,
    available: false,
  }];
}

/**
 * The engines the catalog offers, Matrix AI first, each with every model it
 * lists. A model that cannot run stays in the list and says why.
 */
export function modelEngines(catalog: Catalog, selection: Selection): ModelEngine[] {
  const saved = savedSelection(catalog, selection);
  const instances = offered(catalog);
  const engineIds = instances.map(engineIdOf).filter((id, index, ids) => ids.indexOf(id) === index);

  const engines = engineIds.map((id): ModelEngine => {
    const members = instances.filter((instance) => engineIdOf(instance) === id);
    const listed = members.flatMap((instance) => instance.models.map((model): ModelChoice => {
      const key = modelKey(instance.id, model.id);
      const reason = blockedReason(instance, model);
      return {
        key,
        name: model.displayName,
        detail: joined(routeName(instance, model.displayName), reason),
        logo: ENGINE_LOGO[instance.driverKind],
        selected: key === saved.key,
        available: reason === null,
      };
    }));
    const models = [...lostChoice(saved, id, listed), ...listed];
    const blocked = members.find((instance) => instance.availability !== "available");
    return {
      id,
      label: id === MATRIX_ENGINE_ID ? "Matrix AI" : members[0]!.displayName,
      logo: ENGINE_LOGO[members[0]!.driverKind],
      models,
      note: models.some((model) => model.available) ? null
        : blocked ? canonicalProviderAvailabilityReasonLabel(blocked) : "Models unavailable",
    };
  });

  return [
    ...engines.filter((engine) => engine.id === MATRIX_ENGINE_ID),
    ...engines.filter((engine) => engine.id !== MATRIX_ENGINE_ID),
  ];
}

/** The engine a newly opened sheet shows: the selection's, else the first with a model to run. */
export function openingEngineId(engines: ModelEngine[]): string | null {
  const engine = engines.find((candidate) => candidate.models.some((model) => model.selected))
    ?? engines.find((candidate) => candidate.note === null)
    ?? engines[0];
  return engine?.id ?? null;
}

export function modelTrigger(catalog: Catalog, selection: Selection, catalogLoading: boolean) {
  const saved = savedSelection(catalog, selection);
  return {
    provider: saved.instance ? ENGINE_LOGO[saved.instance.driverKind] : undefined,
    label: selection
      ? joined(routeName(saved.instance, saved.modelLabel), saved.modelLabel, saved.state)
      : catalogLoading ? "Checking models…" : "Choose a model",
    canChoose: offered(catalog).some((instance) => instance.models.some((model) => canRun(instance, model))),
  };
}

function modelNotes(instances: ProviderInstance[], state: string, only: (model: ProviderModel) => boolean): ModelNote[] {
  return instances.flatMap((instance) => instance.models.filter(only).map((model) => ({
    key: modelKey(instance.id, model.id),
    text: joined(canonicalProviderModelRouteLabel(instance, model.displayName), state),
  })));
}

/** The lines under the trigger: what cannot run, and what to do about a saved model that cannot. */
export function modelNotices(catalog: Catalog, selection: Selection, catalogLoading: boolean) {
  const saved = savedSelection(catalog, selection);
  const instances = offered(catalog);
  const reason = !catalog ? "Checking model availability"
    : saved.instance && saved.model && saved.instance.availability !== "available"
      ? canonicalProviderAvailabilityReasonLabel(saved.instance)
      : "Saved model unavailable";

  return {
    reserved: modelNotes(instances.filter(creditReserved), "Credit reserved", () => true),
    unavailable: modelNotes(
      instances.filter((instance) => instance.availability === "available"),
      "Model unavailable",
      (model) => model.availability !== "available",
    ),
    recovery: selection && !saved.available && !catalogLoading
      ? `${reason}. Choose another model or check Agents & providers.`
      : null,
  };
}

/** The selection a tap on a model makes, or null when that model cannot run. */
export function chosenSelection(catalog: Catalog, key: string): CanonicalChatModelSelection | null {
  const index = key.indexOf(MODEL_VALUE_SEPARATOR);
  if (index < 0) return null;
  const instanceId = key.slice(0, index);
  const modelId = key.slice(index + MODEL_VALUE_SEPARATOR.length);
  const instance = offered(catalog).find((candidate) => candidate.id === instanceId);
  const model = instance?.models.find((candidate) => candidate.id === modelId);
  return instance && model && canRun(instance, model) ? { instanceId: instance.id, model: model.id } : null;
}

/** The catalog can run the saved selection as it stands. */
export function selectionCanRun(catalog: Catalog, selection: Selection): boolean {
  return savedSelection(catalog, selection).available;
}
