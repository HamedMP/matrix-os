import { defineCommand } from "citty";
import { createLocalChatHttpTransport, uploadLocalChatArchive, localChatImportErrorText, LocalChatPreviewError, type ImportHarness } from "@matrix-os/contracts/local-chat-import";
import { openLocalChatSource } from "../../import/local-chat-source.js";
import { expandLocalPath } from "../file-transfer-client.js";
import { requireCliAuthToken } from "../auth-state.js";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliSuccess } from "../output.js";
export function localChatImportCommand(harness: ImportHarness) {
  const name = harness === "codex" ? "Codex" : "Claude Code";
  return defineCommand({ meta: { name: harness, description: `Preview or import a selected ${name} transcript as private Chat history and an original archive` },
    args: {
      file: { type: "positional", required: true, description: "Selected local JSONL transcript" },
      apply: { type: "boolean", default: false, description: "Upload original bytes and publish the verified private Chat" },
      title: { type: "string", required: false, description: "Chat title" },
      sha256: { type: "string", required: false, description: "Expected SHA-256 from the approved preview" },
      profile: { type: "string", required: false }, dev: { type: "boolean", default: false }, gateway: { type: "string", required: false },
      token: { type: "string", required: false }, json: { type: "boolean", default: false },
    },
    run: async ({ args }) => {
      const json = args.json === true; const controller = new AbortController();
      const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
      let source: Awaited<ReturnType<typeof openLocalChatSource>> | undefined;
      try {
        source = await openLocalChatSource(expandLocalPath(String(args.file)));
        const preview = await source.preview(harness, controller.signal);
        if (typeof args.sha256 === "string" && preview.sourceHash !== args.sha256.toLowerCase()) throw new LocalChatPreviewError("source_changed");
        if (typeof args.title === "string") {
          const title = args.title.trim(); if (!title || title.length > 160 || /[\u0000-\u001f\u007f]/.test(title)) throw new LocalChatPreviewError("invalid"); preview.title = title;
        }
        if (args.apply !== true) {
          console.log(json ? formatCliSuccess({ preview, applied: false })
            : `Preview: ${preview.title}\nHarness: ${name}\nSession: ${preview.sourceId}\nHuman inputs: ${preview.counts.humanInputs}\nAssistant responses: ${preview.counts.assistantResponses}\nTools: ${preview.counts.toolCalls} calls / ${preview.counts.toolResults} results\nEmbedded media: ${preview.counts.attachments}\nExternal references not included: ${preview.counts.externalReferences}\nSource issues: ${preview.counts.sourceIssues}\nUnknown records retained in archive: ${preview.counts.unknownRecords}\nOriginal bytes: ${preview.rawBytes}\nRaw SHA-256: ${preview.sourceHash}\nRun again with --apply --sha256 ${preview.sourceHash} to import this private Chat and original archive.`);
          return;
        }
        const profile = await resolveCliProfile(args); const token = await requireCliAuthToken(profile);
        const transport = createLocalChatHttpTransport({ baseUrl: profile.gatewayUrl, headers: () => ({ authorization: `Bearer ${token}` }) });
        const result = await uploadLocalChatArchive({ harness, sourceId: preview.sourceId, ...(preview.sourceAgentId ? { sourceAgentId: preview.sourceAgentId } : {}),
          sourceHash: preview.sourceHash, rawSize: preview.rawBytes, title: preview.title }, source, transport, { signal: controller.signal,
          onProgress: progress => { if (!json) console.error(progress.phase === "uploading" ? `Uploading original: ${progress.uploadedBytes}/${progress.totalBytes} bytes` : "Verifying original and publishing private history…"); } });
        console.log(json ? formatCliSuccess({ preview, applied: true, ...result }) : `Verified private Chat: ${result.chatId}\nStored history entries: ${result.messageCount}\nOriginal archive: ${result.jobId}\nThe Chat stays private until you explicitly share it.`);
      } catch (error: unknown) {
        const message = error instanceof Error && "code" in error && ["not_authenticated", "auth_expired"].includes(String(error.code))
          ? "Sign in with matrix login before importing." : localChatImportErrorText(error);
        console.error(json ? formatCliError("chat_import_failed", message) : message); process.exitCode = controller.signal.aborted ? 130 : 1;
      } finally {
        process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
        try { await source?.close(); } catch (error: unknown) { console.warn("[chat/import] source close failed", error instanceof Error ? error.name : "UnknownError"); }
      }
    },
  });
}
