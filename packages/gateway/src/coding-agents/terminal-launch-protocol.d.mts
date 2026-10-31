import type { z } from "zod/v4";
import type { RoutineCliEnvelope, RoutineCliOperation } from "@matrix-os/contracts/routine-cli";
import type { LinuxProcessIdentity } from "../terminal/process-identity.js";
export const TerminalProcessSchema: z.ZodType<LinuxProcessIdentity>;
export type TerminalHostFrame = { type: "host.ready"; wrapper: string; shim: string; digest: string } | { type: "host.disconnect" }
  | { type: "host.terminal.admit"; admissionId: string } | { type: "host.terminal.cancel"; admissionId: string }
  | { type: "host.terminal.result"; admissionId: string; actionId: string; result: RoutineCliEnvelope };
export type TerminalBoundFrame = { type: "terminal.bound"; admissionId: string; host: LinuxProcessIdentity; root: LinuxProcessIdentity;
  supervisor: LinuxProcessIdentity; invocationId: string; generation: string };
export type TerminalShimFrame = { type: "wrapper.ready"; wrapper: string; shim: string; digest: string } | { type: "shim.ready"; shim: string }
  | { type: "wrapper.end"; wrapper: string; shim: string } | TerminalBoundFrame
  | { type: "terminal.call"; admissionId: string; actionId: string; writer: LinuxProcessIdentity; operation: RoutineCliOperation }
  | { type: "terminal.cancel"; admissionId: string; actionId: string } | { type: "terminal.end"; admissionId: string };
export const TerminalHostFrameSchema: z.ZodType<TerminalHostFrame>;
export const TerminalShimFrameSchema: z.ZodType<TerminalShimFrame>;
