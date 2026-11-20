import { Hono } from "hono";
import { Kysely } from "kysely";
import type { BoardActor } from "@matrix-os/contracts/message-board";
import type { MessageBoardDatabase } from "../../packages/gateway/src/message-board/database";
import { createMessageBoardRoutes } from "../../packages/gateway/src/message-board/routes";
import { startMessageBoardRuntime, type MessageBoardRuntime } from "../../packages/gateway/src/message-board/runtime";
import { createHttpMessageBoardClient } from "../../packages/ui/src/message-board/http-client";
import { createTestPGlite } from "../helpers/pglite-test-helper";

export const OWNER: BoardActor = { id: "user:owner_1", kind: "user", name: "You" };
export const FIXER: BoardActor = { id: "agent:tws_1.tt_fixer", kind: "agent", name: "terminal fixer", profile: "fixer" };

/** The real board store and routes on PGlite, with the shipped HTTP client pointed at them. */
export async function createLiveBoard() {
  const pglite = await createTestPGlite();
  const db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
  const runtime: MessageBoardRuntime = await startMessageBoardRuntime(db);
  const app = new Hono();
  app.route("/api/board", createMessageBoardRoutes({
    service: runtime.service, tasks: runtime.tasks, hub: runtime.hub,
    resolveCaller: () => ({ ownerId: "owner_1", actor: OWNER }),
  }));
  const state = { failing: false };
  const client = createHttpMessageBoardClient({
    baseUrl: "http://gateway.test",
    fetch: (async (url: string, init?: RequestInit) => {
      if (state.failing) throw new TypeError("network down");
      return app.request(url.replace("http://gateway.test", ""), init);
    }) as typeof fetch,
  });
  const as = (actor: BoardActor) => ({ ownerId: "owner_1", actor });
  return {
    runtime, client, state, as,
    async close() {
      runtime.close();
      await db.destroy();
    },
  };
}
