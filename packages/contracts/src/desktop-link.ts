// Desktop link (spec 2716): a person's Matrix computer runs Herdr terminals on
// their desktop through an outbound WebSocket the Electron app opens to the
// computer's gateway. Shared by the gateway and Electron Desktop.
//
// Consumed as raw TS source by plain Node: import only from packages, never
// from "./module.js" siblings.
import { z } from "zod/v4";
import { MatrixComputerHandleSchema, MatrixComputerRuntimeSlotSchema } from "#contract-primitives";

/** SHA-256 of the device's Ed25519 public key (SPKI DER), lower-case hex. */
export const DesktopLinkDeviceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Ed25519 signature (64 bytes), base64url without padding. */
export const DesktopLinkSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
/** 32 random bytes, base64url without padding. */
export const DesktopLinkNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const DesktopLinkRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]*$/;
/** What the person calls the desktop ("Hamed's MacBook Pro"). Untrusted: shown, never interpreted. */
export const DesktopLinkNameSchema = z.string().trim().min(1).max(64).regex(SAFE_TEXT);

export const DESKTOP_LINK_PATH = "/ws/desktop-link";
/** Every admission and control frame is JSON text no larger than this. */
export const DESKTOP_LINK_CONTROL_MAX_BYTES = 4 * 1024;
// Deadlines, each longer than the one it waits on (spec 2716, D2): the owner's
// native approval on the desktop, then the computer's core call, then a client
// (shell, CLI) whose request may need that approval.
export const DESKTOP_LINK_APPROVAL_TIMEOUT_MS = 60_000;
export const DESKTOP_LINK_CALL_TIMEOUT_MS = 75_000;
export const DESKTOP_LINK_CLIENT_TIMEOUT_MS = 90_000;

/** Desktops a computer links: 2698 pairs one desktop per computer. */
export const DESKTOP_LINK_MAX_DEVICES = 1;

/** Close codes. Reasons are never sent; the code is the whole answer. */
export const DESKTOP_LINK_CLOSE = {
  /** Admission failed: bad proof, unknown device, wrong revision, too slow. */
  auth: 4401,
  /** The owner removed this device on the computer. Do not reconnect by yourself. */
  removed: 4403,
  /** A newer link for the same device replaced this one. */
  replaced: 4409,
  rateLimited: 4429,
  /** The computer is shutting down or the link was closed cleanly. */
  going: 1001,
  /** A frame broke the protocol or a size cap. */
  policy: 1008,
} as const;

export const DesktopLinkMachineStateSchema = z.enum(["online", "offline"]);
export const DesktopLinkMachineSchema = z.strictObject({
  deviceId: DesktopLinkDeviceIdSchema,
  name: DesktopLinkNameSchema,
  revision: DesktopLinkRevisionSchema,
  state: DesktopLinkMachineStateSchema,
  /** When the computer last heard from the paired desktop; null until it has linked. */
  lastSeenAt: z.string().max(64).nullable(),
});
export type DesktopLinkMachine = z.infer<typeof DesktopLinkMachineSchema>;
export const DesktopLinkMachineListSchema = z.strictObject({
  /** This computer, so a client can build the pairing `If-Match` tag to remove a desktop (2698). */
  machineId: z.uuid(),
  machines: z.array(DesktopLinkMachineSchema).max(DESKTOP_LINK_MAX_DEVICES),
});
// --- Link admission and control (WebSocket text frames) -------------------

export const DesktopLinkChallengeFrameSchema = z.strictObject({
  t: z.literal("challenge"),
  nonce: DesktopLinkNonceSchema,
  machineId: z.uuid(),
});
export const DesktopLinkProofFrameSchema = z.strictObject({
  t: z.literal("proof"),
  /** The desktop's own name: shown and stored for display only (D3), never used to authorize. */
  name: DesktopLinkNameSchema,
  deviceId: DesktopLinkDeviceIdSchema,
  revision: DesktopLinkRevisionSchema,
  signature: DesktopLinkSignatureSchema,
  app: z.strictObject({
    version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
    os: z.string().regex(/^[0-9A-Za-z. _-]{1,64}$/),
  }),
});

/** Names are display-only. An owner's Core alias and Matrix handle may share a name. */
export const DESKTOP_LINK_MAX_HERDR_MACHINES = 32;
const InventoryStateSchema = z.enum(["connected", "unreachable", "unknown"]);
export const DesktopLinkHerdrMachineSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.undefined().optional(),
    core: z.literal("private").optional(),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/),
    state: InventoryStateSchema,
  }),
  z.strictObject({
    source: z.literal("matrix"),
    name: MatrixComputerHandleSchema,
    runtimeSlot: MatrixComputerRuntimeSlotSchema,
    state: InventoryStateSchema,
  }),
]);
export type DesktopLinkHerdrMachine = z.infer<typeof DesktopLinkHerdrMachineSchema>;

export const DesktopLinkStreamSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Frames the gateway sends after admission. */
export const DesktopLinkServerFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("ready"), herdrInventory: z.literal(true).optional() }),
  z.strictObject({ t: z.literal("ping") }),
  z.strictObject({ t: z.literal("pong") }),
  /**
   * Start core stream `stream`: the desktop connects to its core and pipes. Binary
   * frames that follow belong to it. Only one stream is open at a time.
   */
  z.strictObject({ t: z.literal("open"), stream: DesktopLinkStreamSchema }),
  /** End core stream `stream`; the desktop closes its core connection. */
  z.strictObject({ t: z.literal("close"), stream: DesktopLinkStreamSchema }),
  z.strictObject({ t: z.literal("bye"), reason: z.enum(["removed", "shutdown"]) }),
]);
/** Frames the desktop sends after admission. */
export const DesktopLinkClientFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("ping") }),
  z.strictObject({
    t: z.literal("pong"),
    herdrMachines: z.array(DesktopLinkHerdrMachineSchema).max(DESKTOP_LINK_MAX_HERDR_MACHINES).optional(),
    herdrMachinesPartial: z.literal(true).optional(),
  }),
  /**
   * The desktop stopped piping every earlier stream and now pipes `stream`: desktop
   * bytes after this frame belong to it. Bytes before it are from older streams.
   */
  z.strictObject({ t: z.literal("opened"), stream: DesktopLinkStreamSchema }),
  /** Core stream `stream` ended on the desktop (its core went away, or a refused frame). */
  z.strictObject({ t: z.literal("end"), stream: DesktopLinkStreamSchema }),
  z.strictObject({ t: z.literal("bye"), reason: z.enum(["disabled", "signed-out", "quit"]) }),
]);
export type DesktopLinkServerFrame = z.infer<typeof DesktopLinkServerFrameSchema>;
export type DesktopLinkClientFrame = z.infer<typeof DesktopLinkClientFrameSchema>;

// --- Proofs ---------------------------------------------------------------

interface DesktopLinkProof {
  ownerId: string;
  machineId: string;
  deviceId: string;
  nonce: string;
}

// Domain-separated like 2698's desktop-pairing proofs, so no signature made
// for one purpose verifies for another.
function proofMessage(domain: string, parts: readonly (string | number)[]): string {
  return JSON.stringify([domain, ...parts]);
}

/** Signed on every link connect, over that connection's challenge. */
export function desktopLinkProofMessage(input: DesktopLinkProof & { revision: number }): string {
  return proofMessage("matrix-desktop-link-v1", [input.ownerId, input.machineId, input.deviceId, input.revision, input.nonce]);
}

// --- Terminal refs ----------------------------------------------------------

/**
 * Terminals on a linked desktop report under a workspace id of their own per desktop,
 * so refs from two desktops (both with a `t1`) never collide, and every OS view
 * can tell a desktop terminal from a Matrix one by its id alone. Ten zero digits
 * then "mac" in hex, which random workspace ids practically never start with,
 * then the first 16 hex digits of the device id.
 */
export const DESKTOP_LINK_WORKSPACE_PREFIX = "tws_000000000064736b";
const DESKTOP_LINK_WORKSPACE = /^tws_000000000064736b([0-9a-f]{16})$/;

export function desktopLinkWorkspaceId(deviceId: string): string {
  return `${DESKTOP_LINK_WORKSPACE_PREFIX}${deviceId.slice(0, 16)}`;
}

/** The device-id prefix a desktop workspace id names, or null for any other workspace. */
export function desktopLinkDevicePrefix(workspaceId: string | null | undefined): string | null {
  return workspaceId ? DESKTOP_LINK_WORKSPACE.exec(workspaceId)?.[1] ?? null : null;
}

// --- What the desktop exposes -------------------------------------------------

/**
 * herdr-core methods that may cross the link from the computer to the desktop:
 * what the computer's Herdr session host calls, and nothing else. The desktop's
 * guard refuses every other method, and every parameter these do not need,
 * before its core sees them; the core's handshake offers only these.
 */
export const DESKTOP_LINK_METHODS = [
  "terminal.list", "terminal.run", "terminal.attach", "terminal.kill",
] as const;
export type DesktopLinkMethod = (typeof DESKTOP_LINK_METHODS)[number];
