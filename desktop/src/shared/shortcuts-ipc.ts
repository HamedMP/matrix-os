// IPC contract for customizable keyboard shortcuts (specs/653). The main
// process owns the bindings; the renderer reads a snapshot, submits whole
// override documents, and is told when they change.
import { z } from "zod/v4";
import {
  MAX_BINDINGS_PER_ACTION,
  SHORTCUT_ACTION_IDS,
  ShortcutOverridesSchema,
  isCanonicalBinding,
} from "@matrix-os/contracts/keyboard-shortcuts";

const Ok = z.strictObject({ ok: z.boolean() });
const ShortcutActionIdSchema = z.enum(SHORTCUT_ACTION_IDS);

export const ShortcutSnapshotSchema = z.strictObject({
  platform: z.enum(["mac", "other"]),
  overrides: ShortcutOverridesSchema,
  effective: z.record(ShortcutActionIdSchema, z.array(z.string().max(40)).max(MAX_BINDINGS_PER_ACTION)),
});
export type ShortcutSnapshot = z.infer<typeof ShortcutSnapshotSchema>;

/** A terminal profile binds at most 20 commands; the rest is headroom. */
export const MAX_TERMINAL_CLAIMS = 32;
// The main process drops bindings that cannot be pressed on its platform.
const TerminalClaimSchema = z.string().max(40).refine((binding) => isCanonicalBinding(binding, "mac"));

export const SHORTCUT_INVOKE = {
  "shortcuts:get": { request: z.strictObject({}), response: ShortcutSnapshotSchema },
  "shortcuts:set": { request: z.strictObject({ overrides: ShortcutOverridesSchema }), response: ShortcutSnapshotSchema },
  "shortcuts:set-recording": { request: z.strictObject({ recording: z.boolean() }), response: Ok },
  // The keys the focused Terminal in the sender handles itself; [] ends the claim.
  "shortcuts:set-terminal-claims": {
    request: z.strictObject({ bindings: z.array(TerminalClaimSchema).max(MAX_TERMINAL_CLAIMS) }),
    response: Ok,
  },
} as const;

export const SHORTCUT_EVENTS = {
  "shortcuts:changed": ShortcutSnapshotSchema,
  "shortcut:action": z.strictObject({ id: ShortcutActionIdSchema }),
} as const;
