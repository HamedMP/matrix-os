// Named native/model transport fixture; exact 0.162.1 JSON schemas validate consumed native contracts.
import Ajv from "ajv";
import { readFile, appendFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createInterface } from "node:readline";
const schema = JSON.parse(gunzipSync(readFileSync(new URL("./codex-0162/app-server-schema-0162.json.gz", import.meta.url))).toString("utf8"));
const ajv = new Ajv({ schemaId: "auto", unknownFormats: "ignore", logger: false });
const check = name => ajv.compile({ $ref: "#/definitions/" + name, definitions: schema.definitions });
const client = check("ClientRequest"), output = check("DynamicToolCallResponse"), server = check("ServerRequest");
const config = JSON.parse(await readFile(process.env.TEST_ROUTINE_NATIVE_FILE, "utf8"));
const record = value => appendFile(config.records, JSON.stringify(value) + "\n");
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
let turn = 0, processTurns = 0, completed = 0, controlState = "";
const control = config.controlFile ? setInterval(async () => {
  if (!turn) return;
  let text;
  try { text = await readFile(config.controlFile, "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (text === controlState) return; controlState = text;
  if (text === "overflow" || text === "after-overflow") {
    const request = { id: turn * 100 + (text === "overflow" ? 8 : 9), method: "item/tool/call", params: { threadId: "fixture_native_thread", turnId: "fixture_native_turn_" + turn, callId: "native_" + text + "_call_" + turn, tool: "matrix_routines", arguments: config.intent ?? { args: ["list"] } } };
    if (!server(request)) throw new Error("Fixture rejected overflow native request");
    emit(request);
  }
  if (text === "complete") { emit({ method: "turn/completed", params: { threadId: "fixture_native_thread", turn: { id: "fixture_native_turn_" + turn, status: "completed" } } }); }
}, 10) : undefined;
control?.unref();
let history;
if (config.historyFile) {
  await record({ fixtureEvent: "native.start", pid: process.pid });
  process.once("SIGTERM", () => { void record({ fixtureEvent: "native.exit", pid: process.pid }).finally(() => process.exit(0)); });
}
async function restoreHistory(message) {
  try { history = JSON.parse(await readFile(config.historyFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (message.method === "thread/start") {
    if (history) throw new Error("Named history fixture forbids replacement thread");
    history = { threadId: "fixture_native_thread", prompts: [], turnCount: 0, dynamicTools: message.params.dynamicTools ?? [] };
  } else if (!history || history.threadId !== message.params.threadId) throw new Error("Named history fixture rejected changed checkpoint identity");
  turn = history.turnCount;
  await writeFile(config.historyFile, JSON.stringify(history));
}
const responses = new Set();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line); await record(message);
  if (message.method && message.id !== undefined) {
    if (!client(message)) throw new Error("Fixture rejected native client contract: " + JSON.stringify(client.errors));
    if (message.method === "initialize") {
      if (message.params?.capabilities?.experimentalApi !== true) throw new Error("Missing experimental API");
      emit({ id: message.id, result: { userAgent: "named-codex-0162-fixture" } });
    } else if (message.method === "thread/start" || message.method === "thread/resume") {
      if (message.method === "thread/resume" && Object.hasOwn(message.params, "dynamicTools")) throw new Error("Unsupported resume field");
      if (config.historyFile) await restoreHistory(message);
      emit({ id: message.id, result: { thread: { id: message.params.threadId ?? "fixture_native_thread" } } });
    } else if (message.method === "turn/start") {
      turn++; processTurns++; const turnId = "fixture_native_turn_" + turn;
      if (history) {
        history.prompts.push(message.params.input.map(item => item.type === "text" ? item.text : "[other]").join("\n"));
        history.turnCount = turn; await writeFile(config.historyFile, JSON.stringify(history));
      }
      emit({ id: message.id, result: { turn: { id: turnId } } });
      if (history) emit({ method: "item/agentMessage/delta", params: { threadId: history.threadId, turnId, itemId: "history_" + turn, delta: "Named native history retained: " + history.prompts.length } });
      for (const [index, override] of (config.calls ?? [{}]).entries()) {
        const request = { id: turn * 100 + index + 7, method: "item/tool/call", params: {
          threadId: "fixture_native_thread", turnId, callId: "native_call_" + turn + "_" + index, tool: "matrix_routines", arguments: config.intents?.[turn - 1] ?? config.intent ?? { args: ["list"] }, ...override,
        } };
        if (!server(request)) throw new Error("Fixture rejected native server contract");
        emit(request);
      }
      if (config.endBeforeResult) emit({ method: "turn/completed", params: { threadId: "fixture_native_thread", turn: { id: turnId, status: "completed" } } });
    } else if (message.method === "mcpServerStatus/list" && config.historyFile) {
      // Named MCP readiness fixture only; no browser, credentials or provider is invoked.
      emit({ id: message.id, result: { data: [{ name: "matrix_shared_browser", runtimeStatus: "connected", tools: { shared_browser: {} } }] } });
    } else if (message.method === "thread/fork" && config.historyFile) throw new Error("Named history fixture forbids thread fork");
    else if (message.method === "turn/interrupt") {
      emit({ id: message.id, result: {} });
      emit({ method: "turn/completed", params: { threadId: "fixture_native_thread", turn: { id: "fixture_native_turn_" + turn, status: "interrupted" } } });
    } else emit({ id: message.id, result: {} });
  } else if (message.id !== undefined) {
    if (message.result && !output(message.result)) throw new Error("Fixture rejected dynamic result contract");
    responses.add(message.id);
    if (responses.size >= (config.calls ?? [{}]).length * processTurns && !config.endBeforeResult && !config.holdAfterResult) {
      completed++; emit({ method: "turn/completed", params: { threadId: "fixture_native_thread", turn: { id: "fixture_native_turn_" + turn, status: "completed" } } });
      if (completed >= (config.turns ?? 1)) process.exit(0);
    }
  }
}
