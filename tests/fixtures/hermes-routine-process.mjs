// Named native/API/auth/model fixture ONLY. Real process/private FD; no plugin registry or source registrar replica.
import { readFile, appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
const settings = JSON.parse(await readFile(process.argv[2], "utf8"));
const pipe = new Socket({ fd: 3, readable: true, writable: true });
const native = { task_id: "native_task", session_id: "native_durable", turn_id: "native_turn", tool_call_id: "native_call", api_request_id: "native_api" };
const actionId = randomUUID(); let completed = false, calls = 0;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const event = (type, payload) => send({ jsonrpc: "2.0", method: "event", params: { type, session_id: "live_rpc", payload } });
const record = async value => { if (++calls > 128) throw new Error("Named fixture record cap exceeded"); await appendFile(settings.records, JSON.stringify(value) + "\n"); };
const complete = () => { if (!completed) { completed = true; event("message.complete", { text: "Fixture done", status: "complete" }); } };
const call = () => {
  const frame = { type: "call", id: actionId, context: native, intent: settings.intent };
  pipe.write(JSON.stringify(settings.frame ?? frame) + "\n");
  if (settings.duplicate) pipe.write(JSON.stringify(frame) + "\n");
};
const privateLines = createInterface({ input: pipe });
privateLines.on("line", line => {
  if (Buffer.byteLength(line) > 196608) throw new Error("Named fixture frame cap exceeded");
  const value = JSON.parse(line);
  if (value.type === "enable" && !settings.loseEnableAck) pipe.write(JSON.stringify({ type: "enabled" }) + "\n");
  void record({ privateResult: value }).then(() => { if (value.type === "result" && !settings.hold) complete(); });
});
pipe.on("error", error => { if (!["EPIPE", "ECONNRESET"].includes(error.code)) throw error; });
pipe.on("end", () => { void record({ privateEOF: true }); if (!settings.hold) complete(); });
pipe.write(JSON.stringify({ type: "ready", version: 1, pin: "d337b736aa1e8ebecfab043842d13e4a2d2f48a3" }) + "\n");
const rpc = createInterface({ input: process.stdin });
rpc.on("line", line => {
  const request = JSON.parse(line);
  if (request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id)) throw new Error("Invalid actual RPC request");
  void record({ rpc: request });
  let result;
  switch (request.method) {
    case "session.create": case "session.resume": result = { session_id: "live_rpc", stored_session_id: "native_durable" }; break;
    case "session.cwd.set": result = { cwd: request.params.cwd }; break;
    case "config.set":
      result = request.params.key === "yolo" ? { key: "yolo", value: "1", scope: "session" } : { confirm_required: false };
      if (request.params.key === "yolo") event("session.info", { lazy: false, tools: { matrix_routines: settings.missingCatalog ? [] : ["matrix_routines"] } });
      break;
    case "prompt.submit": result = { status: "streaming" }; setTimeout(() => { if (settings.missingCatalog) complete(); else call(); }, 10); break;
    case "session.interrupt": result = { status: "interrupted" }; complete(); break;
    case "session.steer": result = { status: "queued", text: request.params.text }; break;
    default: throw new Error("Unsupported actual RPC method");
  }
  send({ jsonrpc: "2.0", id: request.id, result });
});
rpc.on("close", () => { pipe.destroy(); clearInterval(timer); });
let lastControl;
const timer = setInterval(async () => {
  let control;
  try { control = await readFile(settings.control, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!control || lastControl === control) return; lastControl = control;
  if (control === "end") complete();
  if (control === "eof") pipe.end();
  if (control === "cancel") pipe.write(JSON.stringify({ type: "cancel", id: actionId }) + "\n");
  if (control === "late") call();
}, 10);
event("gateway.ready", {});
