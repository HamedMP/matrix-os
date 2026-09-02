import { z } from "zod/v4";

const SupportVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const SupportChatPropertiesSchema = z.object({
  matrix_client: z.enum(["web", "desktop"]),
  matrix_bundle_version: SupportVersionSchema.optional(),
  matrix_desktop_version: SupportVersionSchema.optional(),
}).strict();

export type SupportChatProperties = z.infer<typeof SupportChatPropertiesSchema>;

export interface BuildSupportChatPropertiesInput {
  client: SupportChatProperties["matrix_client"];
  systemInfo?: unknown;
  desktopVersion?: unknown;
}

function safeVersion(value: unknown): string | undefined {
  const parsed = SupportVersionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function bundleVersionFromSystemInfo(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const info = value as {
    runningVersion?: unknown;
    version?: unknown;
    release?: { version?: unknown };
  };
  return safeVersion(info.runningVersion)
    ?? safeVersion(info.release?.version)
    ?? safeVersion(info.version);
}

export function buildSupportChatProperties({
  client,
  systemInfo,
  desktopVersion,
}: BuildSupportChatPropertiesInput): SupportChatProperties {
  const bundleVersion = bundleVersionFromSystemInfo(systemInfo);
  const nativeVersion = client === "desktop" ? safeVersion(desktopVersion) : undefined;

  return SupportChatPropertiesSchema.parse({
    matrix_client: client,
    ...(bundleVersion ? { matrix_bundle_version: bundleVersion } : {}),
    ...(nativeVersion ? { matrix_desktop_version: nativeVersion } : {}),
  });
}
