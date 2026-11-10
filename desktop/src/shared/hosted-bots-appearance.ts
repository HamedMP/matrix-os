import { z } from "zod/v4";

// Each value is a color from the Matrix shell palette. No URLs, CSS declarations,
// selectors or scripts cross the renderer-to-main boundary.
const Color = z.string().min(1).max(96).regex(/^[#a-zA-Z0-9.,%() +\/-]+$/);

export const HostedBotsAppearanceSchema = z.strictObject({
  mode: z.enum(["light", "dark"]),
  background: Color,
  sidebar: Color,
  surface: Color,
  raised: Color,
  sunken: Color,
  overlay: Color,
  hover: Color,
  border: Color,
  foreground: Color,
  muted: Color,
  accent: Color,
  accentText: Color,
  onAccent: Color,
  focus: Color,
  success: Color,
  onSuccess: Color,
  danger: Color,
  onDanger: Color,
  warning: Color,
});

export type HostedBotsAppearance = z.infer<typeof HostedBotsAppearanceSchema>;
