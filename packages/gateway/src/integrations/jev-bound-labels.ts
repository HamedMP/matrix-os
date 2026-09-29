import { z } from "zod/v4";
import { JevInboxGmailIdSchema } from "@matrix-os/contracts";
import type { PipedreamConnectClient } from "./pipedream.js";
import { JevReadBindingSchema, executeJevBoundRead } from "./jev-bound-read.js";
import { JevCategoryLabel, JevUserLabelId } from "./pipedream-bounded-labels.js";

export const JevLabelInput = z.strictObject({ threadId: JevInboxGmailIdSchema,
  messageIds: z.array(JevInboxGmailIdSchema).min(1).max(4).refine(ids => new Set(ids).size === ids.length),
  labels: z.array(JevCategoryLabel).min(1).max(8).refine(labels => new Set(labels).size === labels.length) });
export const JevLabelConfirmation = z.strictObject({ confirmed: z.literal(true),
  messageIds: z.array(JevInboxGmailIdSchema).min(1).max(4), labelIds: z.array(JevUserLabelId).min(1).max(8) });
const Inventory = z.object({ labels: z.array(z.object({ id: z.string().max(160), name: z.string().max(500),
  type: z.enum(["system", "user"]) })).max(10_000) });
const Message = z.object({ id: JevInboxGmailIdSchema, threadId: JevInboxGmailIdSchema,
  labelIds: z.array(z.string().max(160)).max(10_000) });
export class JevBoundLabelError extends Error {
  constructor() { super("Mailbox labeling could not be confirmed"); this.name = "JevBoundLabelError"; }
}

/** Exact owner/connection and a live identity check before every mutation; additive labels only. */
export async function executeJevBoundLabels(options: {
  ownerId: string; externalUserId: string;
  connection: Parameters<typeof executeJevBoundRead>[0]["connection"];
  binding: z.infer<typeof JevReadBindingSchema>; input: z.infer<typeof JevLabelInput>;
  pipedream: PipedreamConnectClient; signal: AbortSignal;
}) {
  const input = JevLabelInput.parse(options.input);
  if (options.binding.labelingEnabled !== true || !options.pipedream.boundedGmailLabels) throw new JevBoundLabelError();
  const call = options.pipedream.boundedGmailLabels;
  const identity = { externalUserId: options.externalUserId, accountId: options.connection.pipedream_account_id };
  const verify = async () => {
    options.signal.throwIfAborted();
    await executeJevBoundRead({ ...options, action: "get_profile" });
    options.signal.throwIfAborted();
  };
  await verify();
  const inventory = Inventory.parse(await call({ ...identity, kind: "labels" }, options.signal));
  const labelIds: string[] = [];
  for (const name of input.labels) {
    const matches = inventory.labels.filter(label => label.name === name);
    if (matches.length > 1 || (matches.length === 1 && matches[0]!.type !== "user")) throw new JevBoundLabelError();
    if (matches.length) labelIds.push(JevUserLabelId.parse(matches[0]!.id));
    else {
      await verify();
      const created = z.object({ id: JevUserLabelId, name: JevCategoryLabel, type: z.literal("user") })
        .parse(await call({ ...identity, kind: "create-label", name }, options.signal));
      if (created.name !== name) throw new JevBoundLabelError();
      labelIds.push(created.id);
    }
  }
  const ids = new Set(labelIds);
  if (ids.size !== input.labels.length) throw new JevBoundLabelError();
  for (const messageId of input.messageIds) {
    await verify();
    const before = Message.parse(await call({ ...identity, kind: "message-labels", messageId }, options.signal));
    if (before.id !== messageId || before.threadId !== input.threadId) throw new JevBoundLabelError();
    const missing = labelIds.filter(id => !before.labelIds.includes(id));
    if (missing.length) {
      await verify();
      await call({ ...identity, kind: "add-labels", messageId, labelIds: missing }, options.signal);
    }
    const after = Message.parse(await call({ ...identity, kind: "message-labels", messageId }, options.signal));
    if (after.id !== messageId || after.threadId !== input.threadId || !labelIds.every(id => after.labelIds.includes(id))) {
      throw new JevBoundLabelError();
    }
  }
  options.signal.throwIfAborted();
  return JevLabelConfirmation.parse({ confirmed: true, messageIds: input.messageIds, labelIds });
}
