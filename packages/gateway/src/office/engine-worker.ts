import { parentPort } from "node:worker_threads";
import type { OfficeDocumentErrorCode } from "@matrix-os/contracts/office-documents";
import { OfficeDocumentError, officeEngineCodeName, officeEngineErrorCode } from "./document-error.js";
import { isEngineOperation, runEngineOperation, type EngineInput, type EngineOperation } from "./engine-operations.js";

/**
 * The engine thread: one operation at a time, sent by the pool in
 * `engine-pool.ts`. It only computes; it never reads or writes a file. The
 * pool ends this thread when an operation overruns its time budget, so a
 * recalculation that never finishes cannot hold the gateway.
 */

export interface EngineWorkerRequest {
  id: number;
  operation: string;
  input: unknown;
}

export type EngineWorkerReply =
  | { ready: true }
  | { id: number; ok: true; output: unknown }
  | { id: number; ok: false; code: OfficeDocumentErrorCode; name: string; engineCode: string | null; message: string };

/** Log text of a failure, bounded; it stays on the server. */
const MAX_FAILURE_MESSAGE = 500;

function failure(id: number, error: unknown): EngineWorkerReply {
  const code = error instanceof OfficeDocumentError ? error.code : officeEngineErrorCode(error) ?? "internal";
  return {
    id, ok: false, code,
    name: error instanceof Error ? error.name : typeof error,
    engineCode: officeEngineCodeName(error),
    message: (error instanceof Error ? error.message : "").slice(0, MAX_FAILURE_MESSAGE),
  };
}

async function handle(request: EngineWorkerRequest): Promise<EngineWorkerReply> {
  if (!isEngineOperation(request.operation)) {
    return { id: request.id, ok: false, code: "internal", name: "UnknownEngineOperation", engineCode: null, message: "" };
  }
  try {
    const operation: EngineOperation = request.operation;
    return { id: request.id, ok: true, output: await runEngineOperation(operation, request.input as EngineInput<typeof operation>) };
  } catch (error: unknown) {
    return failure(request.id, error);
  }
}

const port = parentPort;
if (port) {
  port.on("message", (request: EngineWorkerRequest) => {
    void handle(request).then((reply) => {
      try { port.postMessage(reply); }
      catch (error: unknown) {
        // An answer that cannot be copied to the gateway thread is a failed operation.
        port.postMessage(failure(request.id, error));
      }
    });
  });
  port.postMessage({ ready: true } satisfies EngineWorkerReply);
}
