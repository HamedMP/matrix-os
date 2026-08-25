import { z } from "zod/v4";

export const CompanionHostSchema = z.enum(["rabbit", "notch"]);
export type CompanionHost = z.infer<typeof CompanionHostSchema>;

export const CompanionPreferencesSchema = z.strictObject({
  rabbitEnabled: z.boolean(),
  notchEnabled: z.boolean(),
}).refine(
  (preferences) => preferences.rabbitEnabled || preferences.notchEnabled,
  { message: "at least one companion host must remain enabled" },
);

export type CompanionPreferences = z.infer<typeof CompanionPreferencesSchema>;

export const DEFAULT_COMPANION_PREFERENCES: CompanionPreferences = {
  rabbitEnabled: true,
  notchEnabled: false,
};
