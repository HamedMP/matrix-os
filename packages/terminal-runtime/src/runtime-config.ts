import { z } from "zod/v4";

const LimitSchema = z.coerce.number().int().min(1).max(10_000);

export interface TerminalRuntimeLimits {
  maxTabsPerWorkspace: number;
  maxTabsTotal: number;
}

export function resolveTerminalRuntimeLimits(
  env: Record<string, string | undefined>,
): TerminalRuntimeLimits {
  const parsed = z.object({
    maxTabsPerWorkspace: LimitSchema,
    maxTabsTotal: LimitSchema,
  }).refine((value) => value.maxTabsTotal >= value.maxTabsPerWorkspace).safeParse({
    maxTabsPerWorkspace: env.MATRIX_TERMINAL_MAX_TABS_PER_WORKSPACE ?? "64",
    maxTabsTotal: env.MATRIX_TERMINAL_MAX_TABS_TOTAL ?? "256",
  });
  if (!parsed.success) throw new Error("Invalid terminal runtime limits");
  return parsed.data;
}
