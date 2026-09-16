import {
  DEFAULT_KERNEL_EFFORT,
  DEFAULT_KERNEL_MODEL,
} from "@matrix-os/kernel";
import { z } from "zod/v4";

export const KERNEL_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;

export const LEGACY_KERNEL_MODEL_IDS = [
  "claude-opus-4-6",
  "claude-sonnet-4-5",
] as const;

export const KernelModelSchema = z.union([
  z.enum(KERNEL_MODEL_IDS),
  z.enum(LEGACY_KERNEL_MODEL_IDS),
]);
export type KernelModel = z.infer<typeof KernelModelSchema>;

const KERNEL_MODEL_DETAILS = {
  "claude-fable-5": { label: "Claude Fable 5", tier: "Highest capability" },
  "claude-opus-5": { label: "Claude Opus 5", tier: "Advanced" },
  "claude-sonnet-5": { label: "Claude Sonnet 5", tier: "Best balance" },
  "claude-haiku-4-5": { label: "Claude Haiku 4.5", tier: "Fastest" },
} as const satisfies Record<(typeof KERNEL_MODEL_IDS)[number], { label: string; tier: string }>;

const LEGACY_KERNEL_MODEL_DETAILS = {
  "claude-opus-4-6": { label: "Claude Opus 4.6", tier: "Legacy" },
  "claude-sonnet-4-5": { label: "Claude Sonnet 4.5", tier: "Legacy" },
} as const satisfies Record<(typeof LEGACY_KERNEL_MODEL_IDS)[number], { label: string; tier: string }>;

export const KERNEL_MODELS = KERNEL_MODEL_IDS.map((id) => ({
  id,
  ...KERNEL_MODEL_DETAILS[id],
}));

export const KERNEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const KernelEffortSchema = z.enum(KERNEL_EFFORTS);
export type KernelEffort = z.infer<typeof KernelEffortSchema>;

export const KERNEL_DEFAULTS = {
  model: DEFAULT_KERNEL_MODEL,
  effort: DEFAULT_KERNEL_EFFORT,
} as const satisfies { model: KernelModel; effort: KernelEffort };

export interface KernelModelOption {
  id: string;
  label: string;
  tier: string;
}

export function normalizeKernelModel(value: unknown): KernelModel | null {
  const parsed = KernelModelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeKernelEffort(value: unknown): KernelEffort | null {
  const parsed = KernelEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function resolveKernelModelOption(model: string): KernelModelOption {
  const current = KERNEL_MODELS.find((option) => option.id === model);
  if (current) return current;
  const legacy = KernelModelSchema.safeParse(model);
  if (legacy.success && LEGACY_KERNEL_MODEL_IDS.includes(legacy.data as (typeof LEGACY_KERNEL_MODEL_IDS)[number])) {
    return { id: legacy.data, ...LEGACY_KERNEL_MODEL_DETAILS[legacy.data as keyof typeof LEGACY_KERNEL_MODEL_DETAILS] };
  }
  return {
    id: model,
    label: model,
    tier: "Custom",
  };
}
