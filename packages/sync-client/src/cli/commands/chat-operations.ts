import { randomUUID } from "node:crypto";
import { defineCommand } from "citty";
import { createChatClient, chatError, readAllChat, renderChatMarkdown, writeChatExport } from "../chat-client.js";
import { watchChat } from "../chat-watch.js";
import { requireCliAuthToken } from "../auth-state.js";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliSuccess, formatNdjsonEvent } from "../output.js";

const common = {
  chat: { type: "positional", required: true, description: "Existing Matrix Chat ID" },
  profile: { type: "string", required: false }, gateway: { type: "string", required: false },
  token: { type: "string", required: false }, dev: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
} as const;
const messages: Record<string, string> = {
  chat_invalid_input: "Check the Chat ID and command options.",
  chat_invalid_response: "Chat response could not be verified. Retry the command.",
  chat_auth_required: "Chat access denied. Check the selected computer or run matrix login.",
  chat_not_found: "Chat not found on the selected computer.",
  chat_conflict: "Chat changed or is busy. Read it before sending again.",
  chat_unavailable: "Chat service unavailable. Try again shortly.",
  chat_timeout: "Chat request timed out. Try again shortly.",
  chat_selection_required: "Choose a model in this Chat before sending from the CLI.",
  chat_send_uncertain: "Message admission is uncertain. Read the Chat before retrying with the same request ID.",
  chat_changed: "Chat changed during export. Retry when its response has finished.",
  chat_limit: "Chat exceeds the command's size limit. Read individual pages instead.",
  chat_file_exists: "Export destination already exists. Choose a new file.",
  chat_export_failed: "Export could not be saved. Check the destination directory.",
  chat_watch_disconnected: "Chat watch disconnected repeatedly. Run watch again to reconnect.",
  chat_output_failed: "Chat watch output closed or could not be written.",
  not_authenticated: "Run matrix login before accessing Chats.",
  auth_expired: "Run matrix login to refresh your session.",
  profile_not_found: "CLI profile not found. Check matrix profile ls.",
};
async function run(args: Record<string, unknown>, action: (client: ReturnType<typeof createChatClient>, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const profile = await resolveCliProfile(args);
    const token = await requireCliAuthToken(profile);
    await action(createChatClient({ gatewayUrl: profile.gatewayUrl, token }), controller.signal);
  } catch (error: unknown) {
    if (controller.signal.aborted && !(error instanceof Error && "requestId" in error)) { process.exitCode = 130; return; }
    const code = error instanceof Error && "code" in error && Object.hasOwn(messages, String(error.code)) ? String(error.code) : "chat_unavailable";
    const requestId = error instanceof Error && "requestId" in error && typeof error.requestId === "string" ? error.requestId : undefined;
    console.error(args.json === true ? formatCliError(code, messages[code], requestId ? { requestId } : undefined)
      : `${messages[code]}${requestId ? ` Request ID: ${requestId}` : ""}`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
function integer(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw chatError("chat_invalid_input");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw chatError("chat_invalid_input");
  return number;
}

export const readChatCommand = defineCommand({ meta: { name: "read", description: "Read a page of messages from a Matrix Chat" },
  args: { ...common, limit: { type: "string", description: "Messages per page (1–200)" }, cursor: { type: "string", description: "Earlier-history cursor from a previous read" } },
  run: async ({ args }) => run(args, async (client, signal) => {
    const detail = await client.read(args.chat, { limit: integer(args.limit, 200, 1, 200), cursor: args.cursor, signal });
    console.log(args.json ? formatCliSuccess({ detail }) : `${renderChatMarkdown(detail)}${detail.nextCursor ? `\nEarlier messages: --cursor ${detail.nextCursor}\n` : ""}`);
  }),
});
export const sendChatCommand = defineCommand({ meta: { name: "send", description: "Send a message and start a response in an existing Chat" },
  args: { ...common,
    message: { type: "string", required: true, description: "Message to send" },
    "request-id": { type: "string", description: "Stable req_ ID; reuse it when retrying uncertain admission" },
    permission: { type: "string", description: "Permission mode (default: supervised)" },
    interaction: { type: "string", description: "Interaction mode (default: default)" },
  },
  run: async ({ args }) => run(args, async (client, signal) => {
    const requestId = args["request-id"] ?? `req_${randomUUID()}`;
    const result = await client.send(args.chat, args.message, { requestId, permission: args.permission, interaction: args.interaction, signal });
    console.log(args.json ? formatCliSuccess(result) : `${result.admission}: ${result.record.chat.id}\nRequest ID: ${result.requestId}\nRun: ${result.run.id}`);
  }),
});
export const exportChatCommand = defineCommand({ meta: { name: "export", description: "Export all saved messages and retrieved tool activity to a private local file" },
  args: { ...common, output: { type: "string", required: true, description: "New destination file; existing files are never overwritten" },
    format: { type: "string", description: "json (default) or markdown" } },
  run: async ({ args }) => run(args, async (client, signal) => {
    const format = args.format ?? "json";
    if (!["json", "markdown"].includes(format)) throw chatError("chat_invalid_input");
    const detail = await readAllChat(client, args.chat, signal);
    const content = format === "markdown" ? renderChatMarkdown(detail) : `${JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), detail }, null, 2)}\n`;
    if (signal.aborted) throw chatError("chat_cancelled");
    await writeChatExport(args.output, content, signal);
    if (signal.aborted) throw chatError("chat_cancelled");
    const receipt = { chatId: args.chat, output: args.output, format, messageCount: detail.messages.length };
    console.log(args.json ? formatCliSuccess(receipt) : `Exported ${receipt.messageCount} messages to ${args.output}`);
  }),
});
export const watchChatCommand = defineCommand({ meta: { name: "watch", description: "Watch one Chat as newline-delimited JSON; Ctrl-C detaches" },
  args: { ...common, cursor: { type: "string", description: "Resume after this event cursor" },
    timeout: { type: "string", description: "Stop after this many seconds (1–86400)" } },
  run: async ({ args }) => run(args, async (client, signal) => {
    const cursor = args.cursor === undefined ? undefined : integer(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const seconds = args.timeout === undefined ? undefined : integer(args.timeout, 0, 1, 86400);
    const stop = new AbortController();
    const timer = seconds === undefined ? undefined : setTimeout(() => stop.abort(), seconds * 1000);
    try {
      await watchChat(client, args.chat, { cursor, signal: AbortSignal.any([signal, stop.signal]), onFrame: async frame => {
        const { type, ...data } = frame;
        await new Promise<void>((resolve, reject) => process.stdout.write(formatNdjsonEvent(type, data), error => error ? reject(error) : resolve()));
      } });
    } finally { if (timer) clearTimeout(timer); }
  }),
});
