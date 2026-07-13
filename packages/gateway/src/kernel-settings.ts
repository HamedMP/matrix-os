import {
  DEFAULT_KERNEL_EFFORT,
  DEFAULT_KERNEL_MODEL,
  type KernelEffort,
} from "@matrix-os/kernel";

export const KERNEL_MODELS = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "Most capable" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", tier: "Balanced" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "Fastest" },
] as const;

export const KERNEL_MODEL_IDS = KERNEL_MODELS.map((model) => model.id) as [string, ...string[]];
export const KERNEL_EFFORTS = ["low", "medium", "high", "max"] as const;
export const KERNEL_DEFAULTS = {
  model: DEFAULT_KERNEL_MODEL,
  effort: DEFAULT_KERNEL_EFFORT,
} as const;

export interface KernelModelOption {
  id: string;
  label: string;
  tier: string;
}

export function normalizeKernelModel(value: unknown): string | null {
  return typeof value === "string" && KERNEL_MODEL_IDS.includes(value) ? value : null;
}

export function normalizeKernelEffort(value: unknown): KernelEffort | null {
  return typeof value === "string" && (KERNEL_EFFORTS as readonly string[]).includes(value)
    ? value as KernelEffort
    : null;
}

export function resolveKernelModelOption(model: string): KernelModelOption {
  return KERNEL_MODELS.find((option) => option.id === model) ?? {
    id: model,
    label: model,
    tier: "Custom",
  };
}
