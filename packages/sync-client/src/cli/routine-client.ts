import { RoutineClientError } from "./routine-client-error.js";
export { RoutineClientError } from "./routine-client-error.js";
import { executeTerminalRoutineOperation } from "./routine-terminal-client.js";
import { RoutineCliEnvelopeSchema, RoutineCliHostFrameSchema, ROUTINE_CLI_AUTH_SCHEME, ROUTINE_CLI_FRAME_BYTES,
  ROUTINE_CLI_OUTPUT_BYTES, ROUTINE_CLI_HTTP_STATUS, routineCliResultMatchesOperation, type RoutineCliOperation, type RoutineCliResult } from "@matrix-os/contracts/routine-cli";
export const routineMutation = (operation: RoutineCliOperation): operation is Extract<RoutineCliOperation, { requestId: string; operation: "propose" | "pause" | "resume" | "archive" }> => ["propose", "pause", "resume", "archive"].includes(operation.operation);
const unknown = (operation: Extract<RoutineCliOperation, { requestId: string }>): RoutineCliResult => ({ kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true });
async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new RoutineClientError("unavailable");
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > ROUTINE_CLI_OUTPUT_BYTES) throw new RoutineClientError("unavailable"); if (value.byteLength) chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { try { await reader.cancel(); } catch (error: unknown) { console.warn("[routine-cli] Response cleanup unavailable", error instanceof Error ? error.name : "UnknownError"); } }
}
/** Actual parent IPC only. Neither a profile nor an environment hint supplies source authority. */
export async function executeRoutineOperation(operation: RoutineCliOperation, signal: AbortSignal): Promise<RoutineCliResult> {
  if (typeof process.send !== "function") return executeTerminalRoutineOperation(operation, signal, process.env.MATRIX_TERMINAL_ROUTINE_SOCKET);
  // Once private IPC exists, disconnection/uncertainty never falls back to a broker.
  if (!process.connected) throw new RoutineClientError("unavailable");
  // AbortSignal.any only arrived in Node20.3; this published client supports all Node>=20.
  // One invocation controller/deadline covers both the private handoff and HTTP response.
  const controller = new AbortController(), combined = controller.signal;
  const forwardAbort = () => controller.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) controller.abort();
  let completed = false, delivered = false;
  let fail!: (error: unknown) => void;
  let onMessage!: (value: unknown, handle?: unknown) => void;
  const disconnected = () => { controller.abort(); fail(new RoutineClientError("unavailable")); };
  const aborted = () => fail(new RoutineClientError("unavailable"));
  const timer = setTimeout(() => { controller.abort(); fail(new RoutineClientError("unavailable")); }, 10000);
  try {
    const capability = await new Promise<Extract<ReturnType<typeof RoutineCliHostFrameSchema.parse>, { type: "routine.capability" }>>((resolve, reject) => {
      fail = reject;
      if (combined.aborted) { reject(new RoutineClientError("unavailable")); return; }
      onMessage = (value, handle) => {
        let encoded: string | undefined;
        try { encoded = JSON.stringify(value); } catch (error: unknown) {
          console.warn("[routine-cli] Frame invalid", error instanceof Error ? error.name : "UnknownError"); controller.abort(); reject(new RoutineClientError("unavailable")); return;
        }
        if (handle || !encoded || Buffer.byteLength(encoded) > ROUTINE_CLI_FRAME_BYTES) { controller.abort(); reject(new RoutineClientError("unavailable")); return; }
        const parsed = RoutineCliHostFrameSchema.safeParse(value);
        if (!parsed.success || delivered) { controller.abort(); reject(new RoutineClientError("unavailable")); return; }
        if (parsed.data.type === "routine.cancel") { controller.abort(); reject(new RoutineClientError("unavailable")); return; }
        if (parsed.data.type === "routine.denied") { reject(new RoutineClientError(parsed.data.code)); return; }
        delivered = true; resolve(parsed.data);
      };
      process.on("message", onMessage); process.once("disconnect", disconnected); combined.addEventListener("abort", aborted, { once: true });
      process.send!({ v: 1, type: "routine.request", operation }, error => { if (error) reject(new RoutineClientError("unavailable")); });
    });
    if (combined.aborted) throw new RoutineClientError("unavailable");
    const response = await fetch(capability.endpoint, { method: "POST", redirect: "error", headers: {
      authorization: `${ROUTINE_CLI_AUTH_SCHEME} ${capability.token}`, "content-type": "application/json",
    }, body: JSON.stringify({ operation }), signal: combined });
    const envelope = RoutineCliEnvelopeSchema.parse(await readResponse(response));
    if (response.ok && "ok" in envelope && routineCliResultMatchesOperation(operation, envelope.data)) { completed = true; return envelope.data; }
    if (response.status >= 400 && response.status < 500 && "error" in envelope
      && (response.status === ROUTINE_CLI_HTTP_STATUS[envelope.error.code] || response.status === 413 && envelope.error.code === "invalid_input")) { completed = true; throw new RoutineClientError(envelope.error.code); }
    throw new RoutineClientError("unavailable");
  } catch (error: unknown) {
    if (error instanceof RoutineClientError && error.code !== "unavailable") throw error;
    if (routineMutation(operation) && !completed) return unknown(operation);
    throw new RoutineClientError("unavailable");
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", forwardAbort); if (onMessage) process.removeListener("message", onMessage); process.removeListener("disconnect", disconnected); combined.removeEventListener("abort", aborted);
  }
}
