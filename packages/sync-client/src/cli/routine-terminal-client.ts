import { connect } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { RoutineCliEnvelopeSchema, RoutineCliOperationSchema, ROUTINE_CLI_OUTPUT_BYTES, routineCliResultMatchesOperation,
  type RoutineCliOperation, type RoutineCliResult } from "@matrix-os/contracts/routine-cli";
import { RoutineClientError } from "./routine-client-error.js";
/** Location only: no source/harness/owner/capability is accepted from env or CLI arguments. */
export function validateTerminalBrokerLocation(raw: unknown): string {
  if (typeof raw !== "string" || !isAbsolute(raw) || normalize(raw) !== raw || Buffer.byteLength(raw) >= 104
    || !/\/matrix-terminal-[a-f0-9]{32}\/routine\.sock$/.test(raw) || /[\u0000-\u0020?#]/.test(raw)) throw new RoutineClientError("source_context_required");
  return raw;
}
export async function executeTerminalRoutineOperation(input: RoutineCliOperation, signal: AbortSignal, location: unknown): Promise<RoutineCliResult> {
  const operation = RoutineCliOperationSchema.parse(input), path = validateTerminalBrokerLocation(location);
  const [directory, socketInfo] = await Promise.all([lstat(dirname(path)), lstat(path)]).catch((error: unknown) => {
    console.warn("[routine-cli] Terminal location unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new RoutineClientError("source_context_required");
  });
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0
    || !socketInfo.isSocket() || socketInfo.isSymbolicLink() || socketInfo.uid !== directory.uid) throw new RoutineClientError("source_context_required");
  const mutation = ["propose", "pause", "resume", "archive"].includes(operation.operation) && "requestId" in operation;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new RoutineClientError("unavailable")); return; }
    const socket = connect(path); let completed = false, sent = false, size = 0; const chunks: Buffer[] = []; // <=128KiB, freed with invocation.
    const finish = (result?: RoutineCliResult, error?: RoutineClientError) => {
      if (completed) return; completed = true; clearTimeout(timer); signal.removeEventListener("abort", abort); socket.destroy(); chunks.length = 0;
      if (result) resolve(result);
      else if (sent && mutation && (!error || error.code === "unavailable")) resolve({ kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true });
      else reject(error ?? new RoutineClientError("unavailable"));
    };
    const abort = () => finish(), timer = setTimeout(abort, 120000); timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      if (completed || signal.aborted) { finish(); return; }
      sent = true; socket.write(JSON.stringify(operation) + "\n"); // Keep writable until result, so disconnect cancels owner waits.
    });
    socket.on("error", () => finish()); socket.once("end", () => finish()); socket.once("close", () => finish());
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length; if (size > ROUTINE_CLI_OUTPUT_BYTES + 1) { finish(); return; }
      chunks.push(chunk); const bytes = Buffer.concat(chunks, size), newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.length - 1) { finish(); return; }
      try {
        const envelope = RoutineCliEnvelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1))));
        if ("error" in envelope) { finish(undefined, new RoutineClientError(envelope.error.code)); return; }
        if (!routineCliResultMatchesOperation(operation, envelope.data)) { finish(); return; }
        finish(envelope.data);
      } catch (error) {
        console.warn("[routine-cli] Terminal result unavailable", error instanceof Error ? error.name : "UnknownError"); finish();
      }
    });
  });
}
