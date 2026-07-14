import { AgentSettingsViewSchema, type AgentSettingsView } from "@matrix-os/contracts";

// Defensive normalizer for GET /api/settings/agent. The model/effort catalog
// (availableModels/availableEfforts/defaults) was added to the gateway after
// the desktop UI shipped, so an older deployed gateway answers with only
// { identity, kernel }. ModelEffortCard must degrade to an explanatory empty
// state instead of crashing on `.map` or a missing `defaults`, so every field
// is coerced here rather than trusted from the wire.

export interface ModelOption {
  id: string;
  label: string;
  tier: string;
}

export interface AgentConfigView {
  kernel: { model: string | null; effort: string | null };
  availableModels: ModelOption[];
  availableEfforts: string[];
  defaults: { model: string | null; effort: string | null };
  extended: AgentSettingsView | null;
  runtimeUpdateRequired: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toModelOption(value: unknown): ModelOption | null {
  const rec = asRecord(value);
  if (typeof rec.id === "string" && typeof rec.label === "string" && typeof rec.tier === "string") {
    return { id: rec.id, label: rec.label, tier: rec.tier };
  }
  return null;
}

export function normalizeAgentConfig(raw: unknown): AgentConfigView {
  const root = asRecord(raw);
  const kernel = asRecord(root.kernel);
  const defaults = asRecord(root.defaults);
  const extended = AgentSettingsViewSchema.safeParse(raw);
  return {
    kernel: { model: asStringOrNull(kernel.model), effort: asStringOrNull(kernel.effort) },
    availableModels: Array.isArray(root.availableModels)
      ? root.availableModels.map(toModelOption).filter((m): m is ModelOption => m !== null)
      : [],
    availableEfforts: Array.isArray(root.availableEfforts)
      ? root.availableEfforts.filter((e): e is string => typeof e === "string")
      : [],
    defaults: { model: asStringOrNull(defaults.model), effort: asStringOrNull(defaults.effort) },
    extended: extended.success ? extended.data : null,
    runtimeUpdateRequired: !extended.success,
  };
}

// The active selection: the saved kernel value wins, else the server default,
// else null. Returns null fields rather than throwing when defaults is absent.
export function selectedModelEffort(cfg: AgentConfigView): { model: string | null; effort: string | null } {
  return {
    model: cfg.kernel.model ?? cfg.defaults.model ?? null,
    effort: cfg.kernel.effort ?? cfg.defaults.effort ?? null,
  };
}
