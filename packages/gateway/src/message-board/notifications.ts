import type { BoardEvent } from "@matrix-os/contracts/message-board";
import { parseJsonArray } from "./rows.js";
import type { MessageBoardService } from "./service.js";
import type { BoardNotification, BoardNotifier } from "./watchers.js";

const MAX_REMEMBERED = 1_000;

/** Drops repeats of a dedupe key; remembers at most 1,000 keys, oldest out. */
export function createDedupingNotifier(send: (notification: BoardNotification) => void | Promise<void>): BoardNotifier {
  const seen = new Set<string>();
  return {
    notify(notification) {
      if (seen.has(notification.dedupeKey)) return;
      seen.add(notification.dedupeKey);
      while (seen.size > MAX_REMEMBERED) {
        const oldest = seen.values().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      Promise.resolve(send(notification)).catch((error: unknown) => {
        console.warn("[message-board] notification failed:", error instanceof Error ? error.name : "UnknownError");
      });
    },
  };
}

/**
 * Board notification sources (spec 2700 section 10): the owner is told when a
 * post mentions them and when a task they created is blocked for a person.
 */
export async function notifyFromBoardEvents(
  board: MessageBoardService,
  notifier: BoardNotifier,
  ownerId: string,
  ownerHandles: readonly string[],
  events: readonly BoardEvent[],
): Promise<void> {
  const owner = `user:${ownerId}`;
  for (const event of events) {
    if (event.actor.id === owner || !event.messageId) continue;
    if (event.type === "message.posted" && ownerHandles.length > 0) {
      const row = await board.db.selectFrom("board_messages").select("mentions").where("id", "=", event.messageId).executeTakeFirst();
      const mentions = row ? parseJsonArray(row.mentions) : [];
      if (mentions.some((handle) => ownerHandles.includes(handle))) {
        notifier.notify({
          ownerId, dedupeKey: `board:${event.messageId}:mention:${ownerId}`,
          title: `Mentioned in #${event.channel ?? "board"}`, body: `${event.actor.profile ?? event.actor.name} mentioned you on the message board.`,
        });
      }
    }
    if (event.type === "task.blocked") {
      const task = await board.db.selectFrom("board_tasks").select(["owner_actor", "claim_epoch"]).where("root_id", "=", event.messageId).executeTakeFirst();
      if (task?.owner_actor !== owner) continue;
      notifier.notify({
        ownerId, dedupeKey: `board:${event.messageId}:blocked:${task.claim_epoch}`,
        title: "A board task needs you", body: `${event.actor.profile ?? event.actor.name} blocked a task in #${event.channel ?? "board"}.`,
      });
    }
  }
}
