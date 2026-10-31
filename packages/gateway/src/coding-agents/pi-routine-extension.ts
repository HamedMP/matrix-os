/** Explicit native Pi extension asset. Builtins only, including from an owned temp directory.
 * JSON schema is rendered from the shared authoritative Zod operation schema by the host. */
export const PI_ROUTINE_EXTENSION = String.raw`import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
const pending = new Map(); // <=8; abort/deadline/EOF/shutdown settle every waiter.
const completed = new Set(); // <=512 result tombstones; late cancelled results cannot close another call.
const seen = new Set(); // <=512 per finite child; never evict/replay call identities.
let socket, ended = false, bytes = "";
const unavailable = JSON.stringify({ v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } });
function unknown(operation) {
  return ["propose", "pause", "resume", "archive"].includes(operation?.operation) && typeof operation.requestId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation.requestId)
    ? JSON.stringify({ v: 1, ok: true, data: { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true } }) : unavailable;
}
function close() {
  if (ended) return; ended = true; socket?.destroy();
  for (const item of [...pending.values()]) item.finish(unknown(item.operation));
}
function send(frame) {
  const text = JSON.stringify(frame) + "\n";
  if (ended || !socket || socket.destroyed || Buffer.byteLength(text) > 196608 || socket.writableLength > 196608) { close(); return false; }
  try { socket.write(text); return true; } catch (error) { console.warn("[pi-routines] Write unavailable", error instanceof Error ? error.name : "UnknownError"); close(); return false; }
}
function connect() {
  if (socket || ended) return;
  try { socket = new Socket({ fd: 3, readable: true, writable: true }); }
  catch (error) { console.warn("[pi-routines] Descriptor unavailable", error instanceof Error ? error.name : "UnknownError"); close(); return; }
  const decoder = new StringDecoder("utf8");
  socket.on("data", chunk => {
    bytes += decoder.write(chunk); if (Buffer.byteLength(bytes) > 196608) { close(); return; }
    let index;
    while ((index = bytes.indexOf("\n")) >= 0) {
      const line = bytes.slice(0, index); bytes = bytes.slice(index + 1);
      let frame; try { frame = JSON.parse(line); } catch (error) { console.warn("[pi-routines] Invalid result", error instanceof Error ? error.name : "UnknownError"); close(); return; }
      if (completed.has(frame.id)) continue;
      const item = pending.get(frame.id);
      if (!item || frame.type !== "result" || JSON.stringify(frame.context) !== JSON.stringify(item.context)
        || typeof frame.result !== "string" || Buffer.byteLength(frame.result) > 131072) { close(); return; }
      item.finish(frame.result);
    }
  });
  socket.once("end", close); socket.once("close", close); socket.once("error", close);
}
export default function (pi) {
  pi.registerTool({
    name: "matrix_routines", label: "Routines",
    description: "Use the fixed Matrix routines CLI. Supply routine intent only. Mutations need the exact owner decision; activation, background model consent and integrations are separate. Never retry an unknown mutation; reconcile its original requestId from a fresh authorized call.",
    parameters: __MATRIX_ROUTINE_SCHEMA__,
    async execute(toolCallId, operation, signal, _onUpdate, ctx) {
      const context = { sessionId: ctx?.sessionManager?.getSessionId(), toolCallId };
      const key = JSON.stringify(context);
      const result = text => ({ content: [{ type: "text", text }], details: {} });
      if (!Object.values(context).every(value => typeof value === "string" && value.length > 0 && value.length <= 512)
        || !signal || signal.aborted || ended || pending.size >= 8 || seen.has(key) || seen.size >= 512) return result(unknown(operation));
      seen.add(key); connect(); if (ended) return result(unknown(operation));
      const id = randomUUID();
      return result(await new Promise(resolve => {
        let settled = false;
        const finish = text => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); pending.delete(id); completed.add(id); resolve(text); };
        const abort = () => { send({ type: "cancel", id }); finish(unknown(operation)); };
        const timer = setTimeout(abort, 120000); timer.unref?.();
        pending.set(id, { context, operation, finish }); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort(); else if (!send({ type: "call", id, context, operation })) finish(unknown(operation));
      }));
    }
  });
}
`;
