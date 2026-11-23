import type { OfficeDocumentErrorCode } from "@matrix-os/contracts/office-documents";
import { OfficeDocumentError, officeEngineCodeName, officeEngineErrorCode } from "./document-error.js";
import { isEngineOperation, runEngineOperation, type EngineInput, type EngineOperation } from "./engine-operations.js";

/** What the gateway thread sends an engine thread: one operation and its plain-data input. */
export interface EngineWorkerRequest {
  id: number;
  operation: string;
  input: unknown;
}

/** What an engine thread answers. A failure carries a client-safe code; the rest is for logs. */
export type EngineWorkerReply =
  | { ready: true }
  | { id: number; ok: true; output: unknown }
  | { id: number; ok: false; code: OfficeDocumentErrorCode; name: string; engineCode: string | null; message: string };

/** Log text of a failure, bounded; it stays on the server. */
const MAX_FAILURE_MESSAGE = 500;

export function engineFailureReply(id: number, error: unknown): EngineWorkerReply {
  const code = error instanceof OfficeDocumentError ? error.code : officeEngineErrorCode(error) ?? "internal";
  return {
    id, ok: false, code,
    name: error instanceof Error ? error.name : typeof error,
    engineCode: officeEngineCodeName(error),
    message: (error instanceof Error ? error.message : "").slice(0, MAX_FAILURE_MESSAGE),
  };
}

/** Runs one request to its reply. Never rejects: every failure becomes a reply. */
export async function handleEngineRequest(request: EngineWorkerRequest): Promise<EngineWorkerReply> {
  if (!isEngineOperation(request.operation)) {
    return { id: request.id, ok: false, code: "internal", name: "UnknownEngineOperation", engineCode: null, message: "" };
  }
  try {
    const operation: EngineOperation = request.operation;
    return { id: request.id, ok: true, output: await runEngineOperation(operation, request.input as EngineInput<typeof operation>) };
  } catch (error: unknown) {
    return engineFailureReply(request.id, error);
  }
}
