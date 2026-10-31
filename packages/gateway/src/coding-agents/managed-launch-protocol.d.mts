import type { z } from "zod/v4";
export const MANAGED_FRAME_BYTES: number;
export const RoutineArgvSchema: z.ZodType<{ args: string[]; stdin?: string }>;
export type ManagedTuple = { admissionId: string; nativeGeneration: string; threadId: string; turnId: string };
export type ManagedShimFrame = { type: "wrapper.end"; wrapper: string; shim: string } | { type: "shim.ready"; shim: string } | { type: "wrapper.ready"; wrapper: string; shim: string; digest: string }
  | ({ type: "shim.bound" } & ManagedTuple) | ({ type: "shim.call"; callId: string; actionId: string; intent: { args: string[]; stdin?: string } } & ManagedTuple)
  | { type: "shim.cancel"; admissionId: string; actionId: string } | { type: "shim.accepted"; admissionId: string } | { type: "shim.end"; admissionId: string };
export type ManagedHostFrame = { type: "host.ready"; wrapper: string; shim: string; digest: string }
  | { type: "host.turn"; admissionId: string; first: boolean; clientRequestId?: string; turn?: { prompt: string; model?: string; modelOptions: Array<{id:string;value:string|boolean}>; browser?: unknown } }
  | { type: "host.result"; admissionId: string; actionId: string; result: string } | { type: "host.cancel"; admissionId: string } | { type: "host.disconnect" };
export const ManagedHostFrameSchema: z.ZodType<ManagedHostFrame>;
export const ManagedShimFrameSchema: z.ZodType<ManagedShimFrame>;
export function parseManagedFrame<T>(schema: z.ZodType<T>, value: unknown): T | undefined;

export function routineUnknownResult(intent?: { args: string[]; stdin?: string }): string;
