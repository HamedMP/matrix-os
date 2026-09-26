import { JevInboxTriageBindingSchema, JevInboxGmailIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { PipedreamConnectClient } from "./pipedream.js";

export const JevReadBindingSchema = JevInboxTriageBindingSchema.omit({ version: true, ownerId: true });
export class JevBoundReadError extends Error {
  constructor(readonly code: "denied" | "unavailable") { super("Integration read unavailable"); this.name = "JevBoundReadError"; }
}
const Profile = z.object({ emailAddress: z.email().max(320) });
const Read = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("get_profile"), params: z.strictObject({}).optional() }),
  z.strictObject({ action: z.literal("list_threads"), params: z.strictObject({}).optional() }),
  z.strictObject({ action: z.literal("get_thread_ids"), params: z.strictObject({ threadId: JevInboxGmailIdSchema }) }),
  z.strictObject({ action: z.literal("get_message"), params: z.strictObject({ messageId: JevInboxGmailIdSchema }) }),
]);

/** Fresh live identity precedes every requested read, pinned to the same owner/connection. */
export async function executeJevBoundRead(options: {
  ownerId: string;
  externalUserId: string;
  connection: { id: string; user_id: string; service: string; status: string; account_label: string | null;
    account_email: string | null; pipedream_account_id: string };
  binding: z.infer<typeof JevReadBindingSchema>;
  action: string;
  params?: Record<string, unknown>;
  pipedream: PipedreamConnectClient;
  signal: AbortSignal;
}): Promise<unknown> {
  const { binding, connection } = options;
  const read = Read.safeParse({ action: options.action, params: options.params });
  if (!read.success || connection.user_id !== options.ownerId || connection.id !== binding.connectionId
    || connection.service !== "gmail" || connection.status !== "active"
    || connection.account_label !== binding.accountLabel || connection.account_email !== binding.expectedEmail) {
    throw new JevBoundReadError("denied");
  }
  const get = options.pipedream.boundedGmailGet;
  if (!get) throw new JevBoundReadError("unavailable");
  const identity = { externalUserId: options.externalUserId, accountId: connection.pipedream_account_id };
  const rawProfile = await get({ ...identity, kind: "profile" }, options.signal);
  const profile = Profile.safeParse(rawProfile);
  if (!profile.success || profile.data.emailAddress !== binding.expectedEmail) throw new JevBoundReadError("denied");
  if (read.data.action === "get_profile") return profile.data;
  if (read.data.action === "list_threads") return get({ ...identity, kind: "threads" }, options.signal);
  if (read.data.action === "get_thread_ids") return get({ ...identity, kind: "thread-ids", id: read.data.params.threadId }, options.signal);
  return get({ ...identity, kind: "message", id: read.data.params.messageId }, options.signal);
}
