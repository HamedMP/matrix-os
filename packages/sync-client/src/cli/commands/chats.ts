import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { importCodexPreview, previewCodexFile } from "../codex-chat-import.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

const SAFE_IMPORT_ERRORS = new Set([
  "Select a regular Codex JSONL file smaller than 20 GiB.",
  "Codex transcript has no supported messages or exceeds the import limit.",
  "Projected conversation exceeds the import limit.",
  "Codex transcript has no session identity",
  "Codex transcript contains multiple session identities",
  "Codex JSONL record exceeds the visible message limit",
  "Selected file does not match the expected SHA-256.",
  "Chat title must be 1–160 printable characters.",
  "Matrix returned an invalid Chat import response.",
  "Matrix returned an invalid Chat import result.",
  "Matrix returned an invalid Chat import offset.",
  "Matrix returned an incomplete Chat import.",
  "The imported Chat could not be verified.",
]);

export function safeCodexImportError(error: unknown): string {
  if (!(error instanceof Error)) return "Chat import failed. Check the selected file and connection, then retry.";
  if (SAFE_IMPORT_ERRORS.has(error.message)
    || /^Invalid Codex JSONL at line [1-9][0-9]{0,9}$/.test(error.message)
    || /^Codex message has no valid timestamp at line [1-9][0-9]{0,9}$/.test(error.message)
    || /^Matrix Chat import request failed \((400|401|403|404|409|413|429|500|502|503|504)\)\.$/.test(error.message)) {
    return error.message;
  }
  return "Chat import failed. Check the selected file and connection, then retry.";
}

const codexCommand = defineCommand({
  meta: { name: "codex", description: "Preview or import one local Codex JSONL session into your private Matrix Chat" },
  args: {
    file: { type: "positional", required: true, description: "Local rollout JSONL file" },
    apply: { type: "boolean", default: false, description: "Create the Chat after preview" },
    title: { type: "string", required: false, description: "Chat title" },
    sha256: { type: "string", required: false, description: "Expected raw file SHA-256" },
    profile: { type: "string", required: false },
    dev: { type: "boolean", default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", default: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    try {
      const preview = await previewCodexFile(String(args.file));
      if (typeof args.sha256 === "string" && preview.sourceHash !== args.sha256.toLowerCase()) {
        throw new Error("Selected file does not match the expected SHA-256.");
      }
      if (typeof args.title === "string") {
        const title = args.title.trim();
        if (!title || title.length > 160 || /[\u0000-\u001f\u007f]/.test(title)) {
          throw new Error("Chat title must be 1–160 printable characters.");
        }
        preview.title = title;
      }
      const summary = { sourceId: preview.sourceId, sourceHash: preview.sourceHash,
        recordedDirectory: preview.cwd, ...(preview.repositoryUrl ? { repositoryUrl: preview.repositoryUrl } : {}),
        title: preview.title, messages: preview.messages.length,
        rawBytes: preview.rawBytes, projectedBytes: preview.projectedBytes };
      if (args.apply !== true) {
        console.log(json ? formatCliSuccess({ preview: summary, applied: false })
          : `Preview: ${summary.title}\nSession: ${summary.sourceId}\nRepository: ${preview.repositoryUrl ?? "not recorded"}\nMessages: ${summary.messages}\nRaw SHA-256: ${summary.sourceHash}\nRun again with --apply to import this private Chat.`);
        return;
      }
      const profile = await resolveCliProfile(args);
      const token = await requireCliAuthToken(profile);
      const result = await importCodexPreview(preview, { gatewayUrl: profile.gatewayUrl, token });
      console.log(json ? formatCliSuccess({ preview: summary, applied: true, ...result })
        : `Imported ${result.messageCount} messages into ${result.chatId}. The Chat is private until you share it.`);
    } catch (error: unknown) {
      const message = safeCodexImportError(error);
      console.error(json ? formatCliError("chat_import_failed", message) : `Chat import failed: ${message}`);
      process.exitCode = 1;
    }
  },
});

export const chatsCommand = defineCommand({
  meta: { name: "chats", description: "Manage Matrix Chats" },
  subCommands: { import: defineCommand({
    meta: { name: "import", description: "Import selected local chat transcripts" },
    subCommands: { codex: codexCommand },
  }) },
});
