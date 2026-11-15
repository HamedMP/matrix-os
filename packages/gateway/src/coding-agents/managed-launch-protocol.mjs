// Shared anonymous-FD transport. None of these DTOs create an owner or source authority.
import { z } from "zod/v4";
import { PendingTurnSchema } from "./codex-runner-config.mjs";
export const MANAGED_FRAME_BYTES = 196608;
const id = z.uuid(), ref = z.string().min(1).max(512);
export const RoutineArgvSchema = z.object({
  args: z.array(z.string().min(1).max(2048)).min(1).max(12),
  stdin: z.string().max(32768).refine(value => Buffer.byteLength(value) <= 32768).optional(),
}).strict().superRefine(({ args, stdin }, context) => {
  const [verb, ...words] = args, flags = new Map(), positional = [];
  let invalid = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!word.startsWith("--")) { positional.push(word); continue; }
    if (flags.has(word) || !["--json", "--input", "--request-id", "--revision"].includes(word)) { invalid = true; break; }
    if (word === "--json") flags.set(word, true);
    else { const value = words[++index]; if (!value || value.startsWith("--")) invalid = true; flags.set(word, value); }
  }
  const allowed = verb === "propose" ? ["--json", "--input", "--request-id"] : ["pause", "resume", "archive"].includes(verb) ? ["--json", "--revision", "--request-id"] : ["--json"];
  if ([...flags.keys()].some(key => !allowed.includes(key))) invalid = true;
  if (verb === "list") invalid ||= positional.length !== 0;
  else if (verb === "show") invalid ||= positional.length !== 1 || !/^rt_[a-f0-9]{24}$/.test(positional[0]);
  else if (verb === "request") invalid ||= positional.length !== 1 || !z.uuid().safeParse(positional[0]).success;
  else if (verb === "propose") invalid ||= positional.length !== 0 || flags.get("--input") !== "-" || typeof stdin !== "string" || !z.uuid().safeParse(flags.get("--request-id")).success;
  else if (["pause", "resume", "archive"].includes(verb)) invalid ||= positional.length !== 1 || !/^rt_[a-f0-9]{24}$/.test(positional[0]) || !/^[1-9][0-9]{0,9}$/.test(flags.get("--revision") ?? "") || !z.uuid().safeParse(flags.get("--request-id")).success;
  else invalid = true;
  if (verb !== "propose" && stdin !== undefined) invalid = true;
  if (invalid) context.addIssue({ code: "custom", message: "Unsupported routine command" });
});
export function routineUnknownResult(intent) {
  const index = intent?.args.indexOf("--request-id") ?? -1, requestId = intent?.args[index + 1];
  return intent && ["propose", "pause", "resume", "archive"].includes(intent.args[0]) && index >= 0 && z.uuid().safeParse(requestId).success
    ? JSON.stringify({ v: 1, ok: true, data: { kind: "unknown", requestId, disposition: "unknown", reconcile: true } })
    : JSON.stringify({ v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } });
}

const tuple = { admissionId: id, nativeGeneration: id, threadId: ref, turnId: ref };
export const ManagedHostFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.ready"), wrapper: id, shim: id, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal("host.turn"), admissionId: id, first: z.boolean(), clientRequestId: z.string().regex(/^req_[A-Za-z0-9_-]+$/).max(160).optional(), turn: PendingTurnSchema.optional() }).strict().refine(frame => frame.first || !!frame.turn && !!frame.clientRequestId),
  z.object({ type: z.literal("host.result"), admissionId: id, actionId: id, result: z.string().max(131072).refine(value => Buffer.byteLength(value) <= 131072) }).strict(),
  z.object({ type: z.literal("host.cancel"), admissionId: id }).strict(),
  z.object({ type: z.literal("host.disconnect") }).strict(),
]);
export const ManagedShimFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shim.ready"), shim: id }).strict(),
  z.object({ type: z.literal("wrapper.end"), wrapper: id, shim: id }).strict(),
  z.object({ type: z.literal("wrapper.ready"), wrapper: id, shim: id, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal("shim.bound"), ...tuple }).strict(),
  z.object({ type: z.literal("shim.call"), ...tuple, callId: ref, actionId: id, intent: RoutineArgvSchema }).strict(),
  z.object({ type: z.literal("shim.cancel"), admissionId: id, actionId: id }).strict(),
  z.object({ type: z.literal("shim.accepted"), admissionId: id }).strict(),
  z.object({ type: z.literal("shim.end"), admissionId: id }).strict(),
]);
export function parseManagedFrame(schema, value) {
  let bytes;
  try { bytes = JSON.stringify(value); } catch (error) { if (!(error instanceof TypeError)) console.warn("[managed-launch] Invalid frame", error instanceof Error ? error.name : "UnknownError"); return undefined; }
  if (!bytes || Buffer.byteLength(bytes) > MANAGED_FRAME_BYTES) return undefined;
  return schema.safeParse(value).data;
}
