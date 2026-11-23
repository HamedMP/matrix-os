/**
 * A fake `window.MatrixOS` for mounting the real Mail app: the integrations
 * bridge answers with raw Gmail and Microsoft Graph JSON (the shapes the
 * gateway returns), `files` is an in-memory home seeded with real fixture
 * bytes, and `ai.generate` returns a canned model reply. Only the host is
 * fake; every adapter, store and component under it is the production code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { FakeBridge } from "../office-accounts/mail/fake-bridge";
import {
  GMAIL_INBOX_LABEL,
  GMAIL_LABELS,
  GMAIL_MESSAGE_A1_FULL,
  GMAIL_MESSAGE_A2_FULL,
  GMAIL_THREAD_A_SUMMARY,
  GMAIL_THREAD_C_SUMMARY,
} from "../office-accounts/mail/gmail-fixtures";
import {
  IDS,
  OUTLOOK_CONVERSATION_A,
  OUTLOOK_FOLDER_LIST,
  OUTLOOK_INBOX_PAGE,
  OUTLOOK_SEARCH_PAGE,
  OUTLOOK_WELL_KNOWN_REPLIES,
} from "../office-accounts/mail/outlook-fixtures";

const FIXTURES = resolve(__dirname, "../../office/fixtures");
export const XLSX_BYTES = new Uint8Array(readFileSync(resolve(FIXTURES, "basic.xlsx")));
export const DOCX_BYTES = new Uint8Array(readFileSync(resolve(FIXTURES, "basic.docx")));
export const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const GMAIL_ADDRESS = "owner@example.com";
export const OUTLOOK_ADDRESS = "owner@contoso.com";
export const AGENT_REPLY = "Hi Bob,\n\nThursday works for me. I will bring the Q3 numbers.\n\nThanks";

const ARCHIVE_FOLDER = { id: "AAMkAGArchive=", displayName: "Archiv", parentFolderId: IDS.root, unreadItemCount: 0, totalItemCount: 3, childFolderCount: 0 };
export const OUTLOOK_ARCHIVE_ID = ARCHIVE_FOLDER.id;

/** The Outlook inbox page without a next link, so the list is complete. */
const OUTLOOK_INBOX = { value: OUTLOOK_INBOX_PAGE.value };
const OUTLOOK_ATTACHMENTS = {
  value: [{ id: "att-1", name: "budget.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: XLSX_BYTES.length, isInline: false }],
};

interface StoredFile {
  bytes: Uint8Array;
  version: string;
}

export interface FakeHome {
  files: Map<string, StoredFile>;
  api: {
    list: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    openRequest: ReturnType<typeof vi.fn>;
    onOpenRequest: ReturnType<typeof vi.fn>;
  };
}

function fileError(code: string): Error {
  return Object.assign(new Error("File request failed"), { name: "BridgeFileError", code });
}

/** An in-memory home with `files.*` shaped like the shell bridge. */
export function fakeHome(seed: Record<string, Uint8Array>): FakeHome {
  const files = new Map<string, StoredFile>();
  let version = 0;
  for (const [path, bytes] of Object.entries(seed)) files.set(path, { bytes, version: `v${++version}` });
  const now = "2026-11-20T09:00:00.000Z";
  const api = {
    list: vi.fn(async (dir: string) => {
      const prefix = dir ? `${dir}/` : "";
      const names = new Map<string, "file" | "dir">();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "dir");
      }
      const entries = [...names.entries()].map(([name, kind]) => ({
        name, path: `${prefix}${name}`, kind, size: kind === "file" ? files.get(`${prefix}${name}`)!.bytes.length : 0, modifiedAt: now,
      }));
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
      return { entries, truncated: false };
    }),
    stat: vi.fn(async (path: string) => {
      const file = files.get(path);
      if (!file) throw fileError("not_found");
      return { path, size: file.bytes.length, modifiedAt: now, version: file.version };
    }),
    read: vi.fn(async (path: string) => {
      const file = files.get(path);
      if (!file) throw fileError("not_found");
      return { path, bytes: new Uint8Array(file.bytes), size: file.bytes.length, version: file.version, mimeType: "" };
    }),
    write: vi.fn(async (path: string, bytes: Uint8Array, options: { ifVersion: string | null }) => {
      const existing = files.get(path);
      if ((options.ifVersion === null && existing) || (options.ifVersion !== null && existing?.version !== options.ifVersion)) {
        throw fileError("version_conflict");
      }
      const stored = { bytes: new Uint8Array(bytes), version: `v${++version}` };
      files.set(path, stored);
      return { path, version: stored.version, size: bytes.length, modifiedAt: now };
    }),
    mkdir: vi.fn(async (path: string) => ({ path })),
    openRequest: vi.fn(async () => null),
    onOpenRequest: vi.fn(() => () => undefined),
  };
  return { files, api };
}

/** Gmail: one inbox conversation (18c1a) and a receipt that only search finds. */
function gmailHandlers(bridge: FakeBridge): void {
  const full = { id: "18c1a", historyId: "100", messages: [GMAIL_MESSAGE_A2_FULL, GMAIL_MESSAGE_A1_FULL] };
  const messages: Record<string, unknown> = { "m-a1": GMAIL_MESSAGE_A1_FULL, "m-a2": GMAIL_MESSAGE_A2_FULL };
  const draft = { id: "r-900", message: { id: "m-900", threadId: "18c1a", labelIds: ["DRAFT"] } };
  bridge
    .handle("gmail", "list_labels", () => GMAIL_LABELS)
    .handle("gmail", "get_label", () => GMAIL_INBOX_LABEL)
    .handle("gmail", "list_threads_query", (params) => {
      if (typeof params.query === "string" && params.query.includes("budget")) return { threads: [{ id: "18c3c" }], resultSizeEstimate: 1 };
      const labels = Array.isArray(params.labelIds) ? params.labelIds : [];
      return labels.includes("INBOX") && !params.query ? { threads: [{ id: "18c1a" }], resultSizeEstimate: 1 } : { threads: [], resultSizeEstimate: 0 };
    })
    .handle("gmail", "get_thread", (params) => {
      if (params.threadId === "18c3c") return GMAIL_THREAD_C_SUMMARY;
      return params.format === "full" ? full : GMAIL_THREAD_A_SUMMARY;
    })
    .handle("gmail", "get_message", (params) => messages[String(params.messageId)] ?? { id: String(params.messageId), payload: { headers: [] } })
    .handle("gmail", "list_drafts", () => ({ drafts: [] }))
    .handle("gmail", "search", () => ({ messages: [], resultSizeEstimate: 0 }))
    .handle("gmail", "create_reply_draft", () => draft)
    .handle("gmail", "create_html_draft", () => ({ id: "r-901", message: { id: "m-901", threadId: "18c99", labelIds: ["DRAFT"] } }))
    .handle("gmail", "update_draft", (params) => (params.draftId === "r-901" ? { id: "r-901", message: { id: "m-901", threadId: "18c99" } } : draft))
    .handle("gmail", "send_draft", () => ({ id: "m-sent", threadId: "18c1a", labelIds: ["SENT"] }))
    .handle("gmail", "delete_draft", () => ({}))
    .handle("gmail", "batch_modify", () => ({}));
}

/** Outlook: the budget conversation (with a spreadsheet) and lunch in the inbox. */
function outlookHandlers(bridge: FakeBridge): void {
  const service = "microsoft_outlook";
  const wellKnown: Record<string, unknown> = { ...OUTLOOK_WELL_KNOWN_REPLIES, archive: ARCHIVE_FOLDER };
  bridge
    .handle(service, "list_folders", () => ({ value: [...OUTLOOK_FOLDER_LIST.value, ARCHIVE_FOLDER] }))
    .handle(service, "get_folder", (params) => {
      const folder = wellKnown[String(params.folderId)];
      if (!folder) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return folder;
    })
    .handle(service, "list_folder_messages", (params) => (params.folderId === IDS.inbox ? OUTLOOK_INBOX : { value: [] }))
    .handle(service, "list_conversation", (params) => {
      if (params.conversationId === "conv-A") return OUTLOOK_CONVERSATION_A;
      return { value: OUTLOOK_INBOX.value.filter((message) => message.conversationId === params.conversationId).map((message) => ({ ...message, body: { contentType: "text", content: message.bodyPreview } })) };
    })
    .handle(service, "list_attachments", () => OUTLOOK_ATTACHMENTS)
    .handle(service, "get_attachment", () => ({
      "@odata.type": "#microsoft.graph.fileAttachment", id: "att-1", name: "budget.xlsx",
      contentType: OUTLOOK_ATTACHMENTS.value[0].contentType, size: XLSX_BYTES.length, contentBytes: toBase64(XLSX_BYTES),
    }))
    .handle(service, "search_messages", (params) => (String(params.query).includes("budget") ? { value: OUTLOOK_SEARCH_PAGE.value } : { value: [] }))
    .handle(service, "update_message", () => ({}))
    .handle(service, "move_message", (params) => ({ id: params.messageId, parentFolderId: params.destinationFolderId }));
}

export interface FakeHost {
  bridge: FakeBridge;
  home: FakeHome;
  ai: { generate: ReturnType<typeof vi.fn>; routes: ReturnType<typeof vi.fn> };
  kv: Map<string, unknown>;
  openApp: ReturnType<typeof vi.fn>;
  /** Installs `window.MatrixOS`. */
  install(): void;
}

/** A host with a Gmail and an Outlook mailbox connected (or the given inventory). */
export function fakeHost(options: { connected?: Array<{ service: string; account_label: string; account_email?: string | null; status: string }> } = {}): FakeHost {
  const bridge = new FakeBridge();
  bridge.connected = options.connected ?? [
    { service: "gmail", account_label: "Personal", account_email: GMAIL_ADDRESS, status: "active" },
    { service: "microsoft_outlook", account_label: "Work", account_email: OUTLOOK_ADDRESS, status: "active" },
  ];
  gmailHandlers(bridge);
  outlookHandlers(bridge);
  const home = fakeHome({ "Documents/basic.xlsx": XLSX_BYTES, "Documents/basic.docx": DOCX_BYTES });
  const kv = new Map<string, unknown>();
  const ai = {
    generate: vi.fn(async (_input: { prompt: string }) => ({ text: JSON.stringify({ body: AGENT_REPLY }) })),
    routes: vi.fn(async () => []),
  };
  const openApp = vi.fn();
  return {
    bridge, home, ai, kv, openApp,
    install() {
      (window as unknown as { MatrixOS: unknown }).MatrixOS = {
        capabilities: () => bridge.capabilities(),
        integrations: () => bridge.integrations(),
        service: (service: string, action: string, params?: Record<string, unknown>, label?: string) => bridge.service(service, action, params, label),
        readData: vi.fn(async (key: string) => kv.get(key) ?? null),
        writeData: vi.fn(async (key: string, value: unknown) => {
          kv.set(key, value);
        }),
        files: home.api,
        ai,
        openApp,
      };
    },
  };
}
