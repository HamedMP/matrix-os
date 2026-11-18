import { z } from "zod/v4";

export const HostedBotsSettingsSectionSchema = z.enum(["services", "mcps", "agents-providers"]);
export type HostedBotsSettingsSection = z.infer<typeof HostedBotsSettingsSectionSchema>;
