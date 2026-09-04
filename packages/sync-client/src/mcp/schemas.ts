import { posix } from "node:path";
import { z } from "zod/v4";

export const MCP_TEXT_FILE_MAX_BYTES = 256 * 1024;
export const MCP_FILE_MAX_BYTES = 1024 * 1024;
export const MCP_TERMINAL_INPUT_MAX_BYTES = 60_000;
export const MCP_DIRECTORY_MAX_ENTRIES = 500;
export const MCP_CHAT_MAX_ITEMS = 100;

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");
const SAFE_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const RuntimeSlotSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

function normalizeMatrixPath(value: string): string {
  if (value.includes("\\") || /[\0\r\n]/.test(value)) {
    throw new Error("invalid_path");
  }
  const homeRelative = value === "~"
    ? "."
    : value.startsWith("~/")
      ? value.slice(2) || "."
      : value;
  if (!homeRelative || homeRelative.startsWith("/")) {
    throw new Error("invalid_path");
  }
  const normalized = posix.normalize(homeRelative);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("invalid_path");
  }
  return normalized;
}

export const MatrixPathSchema = z.string()
  .trim()
  .min(1)
  .max(4096)
  .transform((value, ctx) => {
    try {
      return normalizeMatrixPath(value);
    } catch (err: unknown) {
      if (!(err instanceof Error)) throw err;
      ctx.addIssue({ code: "custom", message: "Invalid Matrix home path" });
      return z.NEVER;
    }
  });

export const MatrixFilePathSchema = MatrixPathSchema.refine((path) => path !== ".", {
  message: "A file path is required",
});

export const TerminalNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const NewTerminalNameSchema = z.string().min(1).max(31).regex(/^[a-z0-9][a-z0-9-]{0,30}$/);
export const TabNameSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
export const ChatIdSchema = z.string().min(6).max(133).regex(/^chat_[A-Za-z0-9_-]+$/);
export const ChatCursorSchema = z.string().min(9).max(512).regex(/^chatcur_[A-Za-z0-9_-]+$/);

export const ComputerInputSchema = z.object({ computer: RuntimeSlotSchema }).strict();

export const RunCommandInputSchema = z.object({
  computer: RuntimeSlotSchema,
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  cwd: MatrixPathSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(30 * 60 * 1000).optional(),
}).strict();

export const CreateTerminalInputSchema = z.object({
  computer: RuntimeSlotSchema,
  name: NewTerminalNameSchema,
  cwd: MatrixPathSchema.optional(),
}).strict();

export const TerminalInputSchema = z.object({
  computer: RuntimeSlotSchema,
  terminal: TerminalNameSchema,
}).strict();

export const CreateTerminalTabInputSchema = TerminalInputSchema.extend({
  name: TabNameSchema.optional(),
  cwd: MatrixPathSchema.optional(),
}).strict();

export const SelectTerminalTabInputSchema = TerminalInputSchema.extend({
  tab: z.number().int().min(0).max(1024),
}).strict();

export const SendTerminalInputSchema = TerminalInputSchema.extend({
  data: z.string().min(1).refine((value) => utf8Bytes(value) <= MCP_TERMINAL_INPUT_MAX_BYTES, {
    message: "Terminal input exceeds byte limit",
  }),
}).strict();

export const ListFilesInputSchema = z.object({
  computer: RuntimeSlotSchema,
  path: MatrixPathSchema.default("."),
}).strict();

export const ReadFileInputSchema = z.object({
  computer: RuntimeSlotSchema,
  path: MatrixFilePathSchema,
}).strict();

export const DownloadFileInputSchema = ReadFileInputSchema;

const UploadBaseSchema = z.object({
  computer: RuntimeSlotSchema,
  path: MatrixFilePathSchema,
  overwrite: z.boolean().default(false),
  secret: z.boolean().default(false),
});

export const UploadFileInputSchema = UploadBaseSchema.extend({
  encoding: z.enum(["utf8", "base64"]),
  content: z.string().max(Math.ceil(MCP_FILE_MAX_BYTES / 3) * 4),
}).strict().superRefine((input, ctx) => {
  if (input.encoding === "base64" && !SAFE_BASE64.test(input.content)) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "Invalid base64 content" });
    return;
  }
  const size = input.encoding === "utf8"
    ? utf8Bytes(input.content)
    : Buffer.from(input.content, "base64").byteLength;
  if (size > MCP_FILE_MAX_BYTES) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "Upload exceeds byte limit" });
  }
});

export type UploadFileInput = z.infer<typeof UploadFileInputSchema>;

export function decodeUploadContent(input: UploadFileInput): Buffer {
  return Buffer.from(input.content, input.encoding === "utf8" ? "utf8" : "base64");
}

const ChatPageFields = {
  computer: RuntimeSlotSchema,
  limit: z.number().int().min(1).max(MCP_CHAT_MAX_ITEMS).default(20),
  projectId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.-]+$/).optional(),
};

export const ListChatsInputSchema = z.object({
  ...ChatPageFields,
  lifecycle: z.enum(["active", "archived"]).optional(),
  cursor: ChatCursorSchema.optional(),
}).strict();

export const SearchChatsInputSchema = z.object({
  ...ChatPageFields,
  query: z.string().trim().min(1).max(200),
}).strict();

export const GetChatInputSchema = z.object({
  computer: RuntimeSlotSchema,
  chatId: ChatIdSchema,
  limit: z.number().int().min(1).max(MCP_CHAT_MAX_ITEMS).default(MCP_CHAT_MAX_ITEMS),
  cursor: ChatCursorSchema.optional(),
}).strict();
