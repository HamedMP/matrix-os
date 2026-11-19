import { z } from "zod/v4";

/**
 * The Browser and Cloud desktop surfaces publish their status and actions to
 * the host window's title bar. Only enumerated values cross that boundary:
 * hosts render labels and icons from these ids, never from embed text.
 */
export const BROWSER_CHROME_ACTIONS = [
  "open-cloud-desktop", "open-browser", "show-desktop", "open-files", "open-terminal", "restore-chrome",
  "takeover", "pause", "resume", "stop", "reconnect", "settings",
] as const;
export type BrowserChromeAction = (typeof BROWSER_CHROME_ACTIONS)[number];

export const BROWSER_CONTROL_LABELS = [
  "You are in control", "Read only", "Agent is working", "Pausing agent…", "Agent paused", "Resuming agent…",
  "Agent control unavailable", "Taking over…", "Stopping agent…",
] as const;

const ActionSchema = z.enum(BROWSER_CHROME_ACTIONS);

export const BrowserChromeModelSchema = z.strictObject({
  surface: z.enum(["browser", "desktop"]),
  connection: z.enum(["connecting", "connected", "disconnected", "unavailable", "inactive"]),
  control: z.enum(BROWSER_CONTROL_LABELS).nullable(),
  busy: z.boolean(),
  settingsOpen: z.boolean(),
  actions: z.array(z.strictObject({ id: ActionSchema, disabled: z.boolean() }))
    .max(BROWSER_CHROME_ACTIONS.length)
    .refine((actions) => new Set(actions.map((action) => action.id)).size === actions.length, "duplicate action"),
});
export type BrowserChromeModel = z.infer<typeof BrowserChromeModelSchema>;

export function parseBrowserChromeAction(value: unknown): BrowserChromeAction | null {
  const parsed = ActionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
