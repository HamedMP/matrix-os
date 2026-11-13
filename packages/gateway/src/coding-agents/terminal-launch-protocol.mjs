// Application frames are Terminal-specific. Shared wrapper handshakes carry no owner authority.
import { z } from "zod/v4";
import { RoutineCliOperationSchema, RoutineCliEnvelopeSchema } from "@matrix-os/contracts/routine-cli";
const id = z.uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const TerminalProcessSchema = z.object({
  pid: z.number().int().min(1).max(2147483647), ppid: z.number().int().min(0).max(2147483647),
  uid: z.number().int().min(0).max(2147483647), gid: z.number().int().min(0).max(2147483647),
  start: z.string().regex(/^[1-9][0-9]{0,24}$/),
}).strict();
export const TerminalHostFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.ready"), wrapper: id, shim: id, digest }).strict(),
  z.object({ type: z.literal("host.disconnect") }).strict(),
  z.object({ type: z.literal("host.terminal.admit"), admissionId: id }).strict(),
  z.object({ type: z.literal("host.terminal.cancel"), admissionId: id }).strict(),
  z.object({ type: z.literal("host.terminal.result"), admissionId: id, actionId: id, result: RoutineCliEnvelopeSchema }).strict(),
]);
export const TerminalShimFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shim.ready"), shim: id }).strict(),
  z.object({ type: z.literal("wrapper.ready"), wrapper: id, shim: id, digest }).strict(),
  z.object({ type: z.literal("wrapper.end"), wrapper: id, shim: id }).strict(),
  z.object({ type: z.literal("terminal.bound"), admissionId: id, host: TerminalProcessSchema, root: TerminalProcessSchema,
    supervisor: TerminalProcessSchema, invocationId: z.string().regex(/^[a-f0-9]{32}$/), generation: z.string().regex(/^gen_[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal("terminal.call"), admissionId: id, actionId: id, writer: TerminalProcessSchema, operation: RoutineCliOperationSchema }).strict(),
  z.object({ type: z.literal("terminal.cancel"), admissionId: id, actionId: id }).strict(),
  z.object({ type: z.literal("terminal.end"), admissionId: id }).strict(),
]);
