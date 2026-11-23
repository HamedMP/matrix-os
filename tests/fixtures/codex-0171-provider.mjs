// Fake Codex 0.171.0 app-server for runner compatibility tests. Every frame the runner
// sends is validated against the retained exact 0.171.0 client schema, and every
// notification this fixture emits is validated against the server schema, so neither
// side can drift from the published protocol. Invalid frames fail the run; the fixture
// never repairs them.
import Ajv from "codex-fixture-ajv";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createInterface } from "node:readline";

const schema = JSON.parse(gunzipSync(readFileSync(new URL("./codex-0171/app-server-schema-0171.json.gz", import.meta.url))).toString("utf8"));
const ajv = new Ajv({ schemaId: "auto", unknownFormats: "ignore", logger: false });
const check = name => ajv.compile({ $ref: "#/definitions/" + name, definitions: schema.definitions });
const clientRequest = check("ClientRequest"), clientNotification = check("ClientNotification"), serverNotification = check("ServerNotification");
const status = process.env.CODEX_0171_FIXTURE_STATUS === "failed" ? "failed" : "completed";
const threadId = "native-thread-0171", turnId = "native-turn-0171";

function reject(reason) {
  process.stderr.write(`codex-0171 fixture rejected ${reason}\n`);
  process.exit(2);
}
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const notify = value => {
  if (!serverNotification(value)) reject(`emitted ${value.method}: ${ajv.errorsText(serverNotification.errors)}`);
  emit(value);
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  const isRequest = Object.hasOwn(message, "id");
  const validate = isRequest ? clientRequest : clientNotification;
  if (!validate(message)) reject(`${isRequest ? "request" : "notification"} ${message.method}: ${ajv.errorsText(validate.errors)}`);
  if (!isRequest) continue;
  if (message.method === "initialize") {
    emit({ id: message.id, result: { userAgent: "fixture", platformFamily: "unix", platformOs: "linux", codexHome: "/private/codex" } });
  } else if (message.method === "thread/start") {
    emit({ id: message.id, result: { thread: { id: threadId }, modelProvider: "openai", cwd: "/private/project", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {} } });
  } else if (message.method === "turn/start") {
    if (message.params.threadId !== threadId) reject(`turn/start for unknown thread ${message.params.threadId}`);
    emit({ id: message.id, result: { turn: { id: turnId } } });
    const tool = { id: "native-tool-0171", type: "mcpToolCall", server: "fixture", tool: "lookup", arguments: {}, status: "completed", environmentId: "private-registration-scope" };
    const answer = { id: "native-answer-0171", type: "agentMessage", phase: "final_answer", text: "Safe provider answer.",
      moderation: { moderated: true, display: { version: 1, mode: "block", reason: { kind: "cyber", trustedAccess: true } } } };
    for (const item of [tool, answer]) {
      notify({ method: "item/started", params: { threadId, turnId, item, startedAtMs: 1 } });
      notify({ method: "item/completed", params: { threadId, turnId, item, completedAtMs: 2, ...(item === answer ? { contentTokenCount: 8 } : {}) } });
    }
    notify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [tool, answer], itemsView: "full", startedAt: null, completedAt: null, durationMs: null,
      error: status === "failed" ? { message: "private bio policy detail", codexErrorInfo: "bioPolicy", additionalDetails: null } : null } } });
    process.exit(0);
  } else {
    reject(`unexpected request ${message.method}`);
  }
}
