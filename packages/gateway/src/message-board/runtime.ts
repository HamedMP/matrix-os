import type { Kysely } from "kysely";
import type { BoardEvent } from "@matrix-os/contracts/message-board";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "./database.js";
import { BoardEventHub } from "./events.js";
import { BoardGrantService } from "./grants.js";
import { notifyFromBoardEvents } from "./notifications.js";
import { BoardScheduleService } from "./schedules.js";
import type { MessageBoardService } from "./service.js";
import { BoardTaskService } from "./tasks.js";
import { BoardWatcherService, type BoardNotifier, type WatcherActionRunner } from "./watchers.js";

/** The message board's long-lived pieces; the gateway owns the database pool, not this. */
export interface MessageBoardRuntime {
  service: MessageBoardService;
  tasks: BoardTaskService;
  hub: BoardEventHub;
  grants: BoardGrantService;
  watchers: BoardWatcherService;
  schedules: BoardScheduleService;
  /** Injects what watchers wake and where notifications go; safe to call after start. */
  configureAutomation(options: { actions?: WatcherActionRunner; notifier?: BoardNotifier; ownerHandles?: readonly string[] }): void;
  /** Stops the scheduler, sweeper and dispatcher, then drains event subscribers. Idempotent. */
  close(): void;
}

export async function startMessageBoardRuntime(db: Kysely<MessageBoardDatabase>, options: { timers?: boolean } = {}): Promise<MessageBoardRuntime> {
  await bootstrapMessageBoardDatabase(db);
  const hub = new BoardEventHub();
  let fanOut: (ownerId: string, events: BoardEvent[]) => void = () => undefined;
  const tasks = BoardTaskService.attach(db, { onEvents: (ownerId, events) => fanOut(ownerId, events) });
  const service = tasks.board;
  const grants = new BoardGrantService(service);
  service.setAccess(grants);
  const watchers = new BoardWatcherService(service);
  const schedules = new BoardScheduleService(service);
  let notifier: BoardNotifier | undefined;
  let ownerHandles: readonly string[] = [];
  fanOut = (ownerId, events) => {
    hub.publish(ownerId, events);
    watchers.onEvents(ownerId, events);
    if (notifier) {
      notifyFromBoardEvents(service, notifier, ownerId, ownerHandles, events).catch((error: unknown) => {
        console.warn("[message-board] notification sources failed:", error instanceof Error ? error.name : "UnknownError");
      });
    }
  };
  if (options.timers !== false) {
    tasks.start();
    watchers.start();
    schedules.start();
  }
  return {
    service, tasks, hub, grants, watchers, schedules,
    configureAutomation(next) {
      watchers.configure({ ...(next.actions ? { actions: next.actions } : {}), ...(next.notifier ? { notifier: next.notifier } : {}) });
      if (next.notifier) notifier = next.notifier;
      if (next.ownerHandles) ownerHandles = next.ownerHandles.map((handle) => handle.toLowerCase());
    },
    close() {
      schedules.stop();
      tasks.stop();
      watchers.stop();
      hub.shutdown();
    },
  };
}
