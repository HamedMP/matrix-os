// IPC for the desktop link (spec 2716): whether the primary computer this device is
// paired with (2698) may use it, as the Terminal window shows and changes it.
// Terminal-window only. Keys, bearers and links stay in main.
import { z } from "zod/v4";

const SlotSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ComputerNameSchema = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/);

export const DesktopLinkStateSchema = z.enum(["off", "connecting", "on", "offline", "removed", "error"]);
export type DesktopLinkStateName = z.infer<typeof DesktopLinkStateSchema>;

export const DesktopLinkStatusSchema = z.strictObject({
  slot: SlotSchema,
  computerName: ComputerNameSchema,
  state: DesktopLinkStateSchema,
});
export type DesktopLinkStatusEntry = z.infer<typeof DesktopLinkStatusSchema>;

const StatusList = z.strictObject({ computers: z.array(DesktopLinkStatusSchema).max(20) });

export const DESKTOP_LINK_INVOKE = {
  "desktop-link:status": { request: z.strictObject({}), response: StatusList },
  /** Turns the link back on (after Stop) for the paired primary computer. */
  "desktop-link:enable": {
    request: z.strictObject({ slot: SlotSchema, computerName: ComputerNameSchema }),
    response: z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), reason: z.enum(["denied", "not_paired", "unavailable"]) }),
    ]),
  },
  /** Opens 2698's native pairing dialog; pairing there turns the link on. */
  "desktop-link:pair": { request: z.strictObject({}), response: z.strictObject({ ok: z.boolean() }) },
  /** This device's own device ids, so a desktops list on this device can leave it out. Both windows may ask. */
  "desktop-link:this-device": { request: z.strictObject({}), response: z.strictObject({ deviceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20) }) },
  /** Closes the link now. */
  "desktop-link:disable": { request: z.strictObject({ slot: SlotSchema }), response: z.strictObject({ ok: z.boolean() }) },
} as const;

export const DESKTOP_LINK_EVENTS = {
  "desktop-link:changed": DesktopLinkStatusSchema,
} as const;

export const DESKTOP_LINK_INVOKE_CHANNELS = Object.keys(DESKTOP_LINK_INVOKE) as Array<keyof typeof DESKTOP_LINK_INVOKE>;
/** Channels only the Terminal window may call: everything that changes or reports links. */
export const DESKTOP_LINK_TERMINAL_ONLY_CHANNELS = DESKTOP_LINK_INVOKE_CHANNELS.filter((channel) => channel !== "desktop-link:this-device");
export const DESKTOP_LINK_EVENT_CHANNELS = Object.keys(DESKTOP_LINK_EVENTS) as Array<keyof typeof DESKTOP_LINK_EVENTS>;
