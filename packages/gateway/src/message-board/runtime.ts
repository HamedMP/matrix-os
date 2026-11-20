import type { Kysely } from "kysely";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "./database.js";
import { BoardEventHub } from "./events.js";
import type { MessageBoardService } from "./service.js";
import { BoardTaskService } from "./tasks.js";

/** The message board's long-lived pieces; the gateway owns the database pool, not this. */
export interface MessageBoardRuntime {
  service: MessageBoardService;
  tasks: BoardTaskService;
  hub: BoardEventHub;
  /** Stops the lease sweeper and pruning, then drains event subscribers. Idempotent. */
  close(): void;
}

export async function startMessageBoardRuntime(db: Kysely<MessageBoardDatabase>): Promise<MessageBoardRuntime> {
  await bootstrapMessageBoardDatabase(db);
  const hub = new BoardEventHub();
  const tasks = BoardTaskService.attach(db, { onEvents: (ownerId, events) => hub.publish(ownerId, events) });
  tasks.start();
  return {
    service: tasks.board,
    tasks,
    hub,
    close() {
      tasks.stop();
      hub.shutdown();
    },
  };
}
