// Named native API/RPC/model producer fixture. NOT the native Pi executable or its loader.
// The production owned extension, retained FD, Matrix source, fixed CLI, HTTP and PG stay real.
import { createInterface } from "node:readline";
import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const args = process.argv.slice(3), sessionId = args[args.indexOf("--session-id") + 1];
const tools = new Map(), frames = createInterface({ input: process.stdin });
for (let n = 0; n < args.length; n++) if (args[n] === "--extension" && args[n + 1].endsWith(".mjs")) {
  const extension = await import(pathToFileURL(args[n + 1]).href);
  extension.default({ registerTool(tool) { tools.set(tool.name, tool); } });
}
let outputEnded = false;
const emit = value => { if (!outputEnded) process.stdout.write(JSON.stringify(value) + "\n"); };
const record = value => appendFile(config.records, JSON.stringify(value) + "\n");
let controller, call, releaseObservation, prompted = false;
const execute = async () => {
  const tool = tools.get("matrix_routines");
  if (!tool) { await record({ missingTool: true }); emit({ type: "agent_end", messages: [] }); emit({ type: "agent_settled" }); return; }
  controller = new AbortController();
  const event = { type: "tool_execution_start", toolName: "matrix_routines", toolCallId: "call_owned", args: config.operation, ...config.event };
  const observe = () => emit(event);
  if (config.order !== "fd-first") observe();
  if (config.terminalBefore) emit({ type: "tool_execution_end", toolName: "matrix_routines", toolCallId: "call_owned", isError: false, result: {} });
  call = tool.execute(config.callId ?? "call_owned", config.operation, controller.signal, () => {}, { sessionManager: { getSessionId: () => config.sessionId ?? sessionId } });
  if (config.order === "fd-first") {
    // Child writes the callback before the parent sends this explicit observation barrier.
    await record({ fdStarted: true });
    await new Promise(resolve => { releaseObservation = resolve; }); observe();
  }
  const result = await call; await record({ result: result.content[0].text });
  emit({ type: "tool_execution_end", toolName: "matrix_routines", toolCallId: "call_owned", isError: false, result });
  if (config.duplicate) await record({ duplicate: (await tool.execute("call_owned", config.operation, controller.signal, () => {}, { sessionManager: { getSessionId: () => sessionId } })).content[0].text });
  if (!config.hold) { emit({ type: "turn_end" }); emit({ type: "agent_end", messages: [] }); emit({ type: "agent_settled" }); }
};
for await (const line of frames) {
  const frame = JSON.parse(line);
  if (frame.type === "get_state") emit({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId } });
  if (frame.type === "prompt") { if (prompted) throw new Error("Duplicate prompt"); prompted = true; await record({ prompt: true, tools: args[args.indexOf("--tools") + 1] }); emit({ type: "agent_start" }); emit({ type: "turn_start" }); void execute(); }
  if (frame.type === "fixture_observe") releaseObservation?.();
  if (frame.type === "fixture_terminal") emit({ type: "tool_execution_end", toolName: "matrix_routines", toolCallId: "call_owned", result: {}, isError: frame.isError });
  if (frame.type === "fixture_cancel") controller?.abort();
  if (frame.type === "fixture_end") { emit({ type: "agent_end", messages: [] }); if (!config.holdDrain) emit({ type: "agent_settled" }); }
  if (frame.type === "fixture_error") emit({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
  if (frame.type === "fixture_settle") emit({ type: "agent_settled" });
  if (frame.type === "fixture_eof") { outputEnded = true; process.stdout.end(); }
  if (frame.type === "abort") { controller?.abort(); process.exit(0); }
}
