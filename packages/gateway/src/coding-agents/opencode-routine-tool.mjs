// Exact v1.16 custom-tool candidate. Only Node builtins: no ambient package/module resolution.
// This resource is not installed by the unqualified production bootstrap.
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const pending = new Map(); // <=8; deadline, abort, pipe EOF and source shutdown settle each waiter.
const completed = new Set(); // <=512 per finite child; late results cannot cancel other native calls.
let socket, ended = false, bytes = "";
const unavailable = JSON.stringify({ v: 1, error: { code: "unavailable", message: "Routine requests are temporarily unavailable." } });
function unknown(intent) {
  const args = Array.isArray(intent?.args) ? intent.args : [], index = args.indexOf("--request-id"), requestId = args[index + 1];
  return index >= 0 && typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
    ? JSON.stringify({ v: 1, ok: true, data: { kind: "unknown", requestId, disposition: "unknown", reconcile: true } }) : unavailable;
}
function close() { ended = true; socket?.destroy(); for (const item of [...pending.values()]) item.finish(unknown(item.intent)); }
function send(frame) {
  const text = JSON.stringify(frame) + "\n";
  if (!socket || ended || Buffer.byteLength(text) > 196608 || socket.writableLength > 196608) { close(); return false; }
  try { socket.write(text); return true; } catch (error) { console.warn("[opencode-routines] Native write unavailable", error instanceof Error ? error.name : "UnknownError"); close(); return false; }
}
function connect() {
  if (socket || ended) return;
  try { socket = new Socket({ fd: 3, readable: true, writable: true }); } catch (error) { console.warn("[opencode-routines] Native descriptor unavailable", error instanceof Error ? error.name : "UnknownError"); close(); return; }
  const decoder = new StringDecoder("utf8");
  socket.on("data", chunk => {
    bytes += decoder.write(chunk); if (Buffer.byteLength(bytes) > 196608) { close(); return; }
    let newline;
    while ((newline = bytes.indexOf("\n")) >= 0) {
      const line = bytes.slice(0, newline); bytes = bytes.slice(newline + 1);
      let frame; try { frame = JSON.parse(line); } catch (error) { console.warn("[opencode-routines] Invalid result", error instanceof Error ? error.name : "UnknownError"); close(); return; }
      if (completed.has(frame.id)) continue;
      const item = pending.get(frame.id);
      if (!item || frame.type !== "result" || JSON.stringify(frame.context) !== JSON.stringify(item.context)
        || typeof frame.result !== "string" || Buffer.byteLength(frame.result) > 131072) { close(); return; }
      item.finish(frame.result);
    }
  });
  socket.once("end", close); socket.once("close", close); socket.once("error", close);
}
export default {
  description: "Invoke the fixed Matrix routines CLI. Supply only routine arguments and optional proposal JSON stdin. Remote mutations require the exact owner decision; activation and background permission are separate.",
  // v1.16 accepts legacy JSON Schema definitions here; the host is the authoritative strict parser.
  args: { intent: { type: "object", additionalProperties: false, properties: {
    args: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 2048 } },
    stdin: { type: "string", maxLength: 32768 },
  }, required: ["args"] } },
  async execute(input, native) {
    const intent = input?.intent;
    const context = { sessionID: native?.sessionID, messageID: native?.messageID, callID: native?.callID,
      agent: native?.agent, directory: native?.directory, worktree: native?.worktree };
    if (!Object.values(context).every(value => typeof value === "string" && value.length > 0 && value.length <= 512)
      || !native?.abort || native.abort.aborted || pending.size >= 8 || completed.size + pending.size >= 512 || ended) return unknown(intent);
    connect(); if (ended) return unknown(intent);
    const id = randomUUID();
    return await new Promise(resolve => {
      const abort = () => { send({ type: "cancel", id }); finish(unknown(intent)); };
      const timer = setTimeout(abort, 120000); timer.unref?.();
      const finish = result => { clearTimeout(timer); native.abort.removeEventListener("abort", abort); pending.delete(id); completed.add(id); resolve(result); };
      pending.set(id, { context, intent, finish }); native.abort.addEventListener("abort", abort, { once: true });
      if (native.abort.aborted) abort(); else if (!send({ type: "call", id, context, intent })) finish(unknown(intent));
    });
  },
};
