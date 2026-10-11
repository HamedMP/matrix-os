import { z } from "zod/v4";

export const DesktopStartupModeSchema = z.enum(["normal", "auth-diagnostic"]);
export type DesktopStartupMode = z.infer<typeof DesktopStartupModeSchema>;
export const DesktopStartupModeResultSchema = z.strictObject({ mode: DesktopStartupModeSchema });
