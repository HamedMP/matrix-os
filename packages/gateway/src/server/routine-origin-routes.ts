import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { BotServices } from "../startup/bots.js";
import type { ChatRepository } from "../chat/repository.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { createRoutineOriginRoutes } from "../bots/routine-origin-routes.js";
import { createBotContinuationAdmitter } from "../bots/continuations.js";
import { requireRequestPrincipal } from "../request-principal.js";

/** Capture actual startup dependencies once. Never substitute owner auth for browser proof. */
export function registerRoutineOriginHttp(options: {
  app: Hono; bots?: BotServices; repository: ChatRepository | null;
  orchestrator: CanonicalChatOrchestrator | null;
}) {
  const { app, bots, repository, orchestrator } = options;
  const service = bots?.routineOrigin, proofs = bots?.routineOriginProofs, machine = bots?.routineOriginMachine;
  if (service && proofs && machine && repository && orchestrator) {
    app.route("/", createRoutineOriginRoutes({ service, verifyApproval: proofs.verifyApproval,
      ...machine, getPrincipal: requireRequestPrincipal,
      admitContinuation: createBotContinuationAdmitter({ repository, orchestrator }) }));
    return;
  }
  const unavailable = (context: Context) => {
    requireRequestPrincipal(context);
    context.header("Cache-Control", "private, no-store");
    return context.json({ code: "unavailable", message: "This task request is unavailable." }, 503);
  };
  app.get("/api/chats/:chatId/routine-origin", unavailable);
  app.post("/api/chats/:chatId/routine-origin/:interactionId/resolve",
    bodyLimit({ maxSize: 2048 }), unavailable);
}
