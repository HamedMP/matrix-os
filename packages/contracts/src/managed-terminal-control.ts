import { z } from "zod/v4";

export const MANAGED_TERMINAL_BROKER_PATH = "/internal/terminal-control";
export const MANAGED_TERMINAL_TARGET_PATH = "/api/internal/terminal-control";
export const MANAGED_TERMINAL_OWNER_GRANT_HEADER = "x-matrix-managed-terminal-owner-grant";
export const MAX_MANAGED_TERMINAL_BODY_BYTES = 36 * 1024;
export const MAX_MANAGED_TERMINAL_RESPONSE_BYTES = 48 * 1024;
export const MAX_MANAGED_TERMINAL_WIRE_BYTES = 66 * 1024;
export const MANAGED_TERMINAL_MAX_COMPUTERS = 40;

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const runtimeSlot = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const ManagedTerminalMachineIdSchema = identifier;
export const ManagedTerminalRuntimeSchema = z.strictObject({
  machineId: identifier,
  ownerId: identifier,
  runtimeSlot,
});
export const ManagedTerminalComputerSchema = z.strictObject({
  machineId: identifier,
  name: z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/),
  runtimeSlot,
});
export const ManagedTerminalComputerListSchema = z.strictObject({
  computers: z.array(ManagedTerminalComputerSchema).max(MANAGED_TERMINAL_MAX_COMPUTERS),
  partial: z.boolean(),
});
export const ManagedTerminalPickerListSchema = ManagedTerminalComputerListSchema.extend({
  computers: z.array(ManagedTerminalComputerSchema.extend({
    workspaceId: z.string().regex(/^tws_6d6774[0-9a-f]{26}$/),
  })).max(MANAGED_TERMINAL_MAX_COMPUTERS),
});

export const ManagedTerminalActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("read"), lines: z.number().int().min(0).max(200) }),
  z.strictObject({ action: z.literal("send"), text: z.string().min(1).max(8 * 1024) }),
  z.strictObject({ action: z.literal("interrupt") }),
]);

const terminalsRequest = z.strictObject({ kind: z.literal("terminals"), targetMachineId: identifier });
export const ManagedTerminalTurnAuthoritySchema = z.strictObject({
  proof: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/),
  clientRequestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ManagedTerminalTurnAuthority = z.infer<typeof ManagedTerminalTurnAuthoritySchema>;
const actionRequest = z.strictObject({
  kind: z.literal("action"),
  targetMachineId: identifier,
  chatId: identifier,
  runId: identifier,
  worktreeId: identifier,
  ref: z.strictObject({
    workspaceId: z.literal("tws_00000000000000000000006865726472"),
    tabId: z.string().regex(/^tt_[a-f0-9]{32}$/),
  }),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  action: ManagedTerminalActionSchema,
});

export const ManagedTerminalBrokerRequestSchema = z.strictObject({
  source: ManagedTerminalRuntimeSchema,
  request: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("computers") }), terminalsRequest,
    actionRequest.extend({ authority: ManagedTerminalTurnAuthoritySchema }),
  ]),
});
export const ManagedTerminalTargetRequestSchema = z.strictObject({
  source: ManagedTerminalRuntimeSchema,
  target: ManagedTerminalRuntimeSchema,
  request: z.discriminatedUnion("kind", [terminalsRequest, actionRequest]),
});
export const ManagedTerminalActionResponseSchema = z.strictObject({ result: z.unknown() });

export type ManagedTerminalBrokerRequest = z.infer<typeof ManagedTerminalBrokerRequestSchema>;
export type ManagedTerminalComputer = z.infer<typeof ManagedTerminalComputerSchema>;
export type ManagedTerminalRuntime = z.infer<typeof ManagedTerminalRuntimeSchema>;
export type ManagedTerminalAction = z.infer<typeof ManagedTerminalActionSchema>;

// Opaque, machine-qualified namespace distinct from the local and paired Desktop Link namespaces.
export const isManagedTerminalRef = (ref: { workspaceId: string }) => /^tws_6d6774[0-9a-f]{26}$/.test(ref.workspaceId);
