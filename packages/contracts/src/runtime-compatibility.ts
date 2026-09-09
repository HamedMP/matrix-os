import { z } from "zod/v4";

const Protocol = z.number().int().min(1).max(10_000);
export const RuntimeCompatibilitySchema = z.object({
  schemaVersion: z.literal(1),
  minDesktopProtocol: Protocol,
  maxDesktopProtocol: Protocol,
}).refine((value) => value.minDesktopProtocol <= value.maxDesktopProtocol);

// API contract generations, not product versions or release timestamps.
// Retain the previous generation until its adapters can safely be retired.
export const DESKTOP_PROTOCOL_VERSION = 1;
export const RUNNING_RUNTIME_COMPATIBILITY = Object.freeze({
  schemaVersion: 1 as const,
  minDesktopProtocol: 1,
  maxDesktopProtocol: 1,
});
export type RuntimeCompatibility = z.infer<typeof RuntimeCompatibilitySchema>;
export type RuntimeCompatibilityStatus =
  | "compatible" | "legacy" | "desktop-update-required" | "runtime-update-required" | "unavailable";

const SystemCompatibilityInfo = z.object({
  version: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  runtimeCompatibility: RuntimeCompatibilitySchema.optional(),
});

export function evaluateRuntimeCompatibility(
  info: unknown,
  desktopProtocol: number = DESKTOP_PROTOCOL_VERSION,
): RuntimeCompatibilityStatus {
  const parsed = SystemCompatibilityInfo.safeParse(info);
  if (!parsed.success || !Protocol.safeParse(desktopProtocol).success) return "unavailable";
  const compatibility = parsed.data.runtimeCompatibility;
  if (!compatibility) return "legacy";
  if (desktopProtocol < compatibility.minDesktopProtocol) return "desktop-update-required";
  if (desktopProtocol > compatibility.maxDesktopProtocol) return "runtime-update-required";
  return "compatible";
}
