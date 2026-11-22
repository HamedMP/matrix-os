// IPC contract for customizable keyboard shortcuts (specs/653). The main
// process owns the bindings; the renderer reads a snapshot, submits whole
// override documents, and is told when they change.
import { z } from "zod/v4";
import {
  MAX_BINDINGS_PER_ACTION,
  SHORTCUT_ACTION_IDS,
  ShortcutOverridesSchema,
} from "@matrix-os/contracts/keyboard-shortcuts";

const Ok = z.strictObject({ ok: z.boolean() });
const ShortcutActionIdSchema = z.enum(SHORTCUT_ACTION_IDS);

export const ShortcutSnapshotSchema = z.strictObject({
  platform: z.enum(["mac", "other"]),
  overrides: ShortcutOverridesSchema,
  effective: z.record(ShortcutActionIdSchema, z.array(z.string().max(40)).max(MAX_BINDINGS_PER_ACTION)),
});
export type ShortcutSnapshot = z.infer<typeof ShortcutSnapshotSchema>;

export const SHORTCUT_INVOKE = {
  "shortcuts:get": { request: z.strictObject({}), response: ShortcutSnapshotSchema },
  "shortcuts:set": { request: z.strictObject({ overrides: ShortcutOverridesSchema }), response: ShortcutSnapshotSchema },
  "shortcuts:set-recording": { request: z.strictObject({ recording: z.boolean() }), response: Ok },
} as const;

export const SHORTCUT_EVENTS = {
  "shortcuts:changed": ShortcutSnapshotSchema,
  "shortcut:action": z.strictObject({ id: ShortcutActionIdSchema }),
} as const;
