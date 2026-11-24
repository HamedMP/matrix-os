// IPC for the Desktop link (spec 2716): which computers may use this device, as the
// Terminal window shows and changes it. Terminal-window only. The renderer
// names a computer by its inventory slot; keys, bearers and links stay in main.
import { z } from "zod/v4";

const SlotSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ComputerNameSchema = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/);

export const DesktopLinkStateSchema = z.enum(["off", "connecting", "on", "offline", "removed", "error"]);
export type DesktopLinkStateName = z.infer<typeof DesktopLinkStateSchema>;

export const DesktopLinkStatusSchema = z.strictObject({
  slot: SlotSchema,
  computerName: ComputerNameSchema,
  state: DesktopLinkStateSchema,
  terminalsFromComputer: z.number().int().min(0).max(10_000),
});
export type DesktopLinkStatusEntry = z.infer<typeof DesktopLinkStatusSchema>;

const StatusList = z.strictObject({ computers: z.array(DesktopLinkStatusSchema).max(20) });

export const DESKTOP_LINK_INVOKE = {
  "desktop-link:status": { request: z.strictObject({}), response: StatusList },
  /** After the person confirmed: enrol this device with that computer if needed, then link. */
  "desktop-link:enable": {
    request: z.strictObject({ slot: SlotSchema, computerName: ComputerNameSchema }),
    response: z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), reason: z.enum(["signed_out", "denied", "too_many", "unavailable"]) }),
    ]),
  },
  /** Closes the link now. */
  "desktop-link:disable": { request: z.strictObject({ slot: SlotSchema }), response: z.strictObject({ ok: z.boolean() }) },
} as const;

export const DESKTOP_LINK_EVENTS = {
  "desktop-link:changed": DesktopLinkStatusSchema,
} as const;

export const DESKTOP_LINK_INVOKE_CHANNELS = Object.keys(DESKTOP_LINK_INVOKE) as Array<keyof typeof DESKTOP_LINK_INVOKE>;
export const DESKTOP_LINK_EVENT_CHANNELS = Object.keys(DESKTOP_LINK_EVENTS) as Array<keyof typeof DESKTOP_LINK_EVENTS>;
