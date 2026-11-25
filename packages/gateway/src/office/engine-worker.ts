import { parentPort } from "node:worker_threads";
import { engineFailureReply, handleEngineRequest, type EngineWorkerReply, type EngineWorkerRequest } from "./engine-protocol.js";

/**
 * The engine thread: one operation at a time, sent by the pool in
 * `engine-pool.ts`. It only computes; it never reads or writes a file. The
 * pool ends this thread when an operation overruns its time budget, so a
 * recalculation that never finishes cannot hold the gateway.
 */
const port = parentPort;
if (port) {
  port.on("message", (request: EngineWorkerRequest) => {
    void handleEngineRequest(request).then((reply) => {
      try { port.postMessage(reply); }
      catch (error: unknown) {
        // An answer that cannot be copied to the gateway thread is a failed operation.
        port.postMessage(engineFailureReply(request.id, error));
      }
    });
  });
  port.postMessage({ ready: true } satisfies EngineWorkerReply);
}
