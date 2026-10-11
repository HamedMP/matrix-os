/**
 * Matrix sources: connect configs. Strict, bounded zod schemas (sorted, de-duplicated lists), the stable identity of
 * each source and its client-safe view. Roots are home-relative folders that never name owner or tool state or a
 * secret-like name.
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  BRAIN_SOURCE_CONFIG_LIMITS, BrainFeatureError, type BrainMatrixChatSourceConfig, type BrainMatrixFilesSourceConfig,
  type BrainMatrixNotesSourceConfig,
} from "../../contracts.js";
import { BRAIN_MATRIX_LIMITS } from "./types.js";

const L = BRAIN_SOURCE_CONFIG_LIMITS;
/** Home folders that hold owner or tool state; mirrors path-security.ts. Dot folders are refused as well. */
const PROTECTED_FIRST_SEGMENTS: readonly string[] = ["system", "agents"];
const DENIED_PREFIXES: readonly string[] = ["data/browser-profiles"];
/** Never walked: hidden names and dependency folders. */
export function isSkippedName(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || /[\u0000-\u001f\u007f]/.test(name);
}

const SECRET_WORD =
  /(^|[._-])(secrets?|credentials?|creds|passwords?|passwd|tokens?|api[-_]?keys?|private[-_]?keys?|service[-_]?accounts?)([._-]|$)/i;
/** Credential file names matched anywhere in a name (serviceAccountKey.json, firebase-adminsdk-x.json, kubeconfig). */
const SECRET_ANYWHERE = /serviceaccount|adminsdk|kubeconfig|id_rsa|id_ed25519|id_ecdsa|(?:^|[._-])sa[-_]key|google-services/i;
const SECRET_EXTENSIONS: readonly string[] = ["jks", "key", "keystore", "p12", "pem", "pfx", "tfvars"];
/** High-confidence credential content: private keys, cloud and chat tokens, service account files. */
const SECRET_CONTENT: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}/, /\bgithub_pat_\w{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /\bsk-ant-[\w-]{20,}/,
];
const SERVICE_ACCOUNT = /"type"\s*:\s*"service_account"/;

/**
 * Names that usually hold credentials (credentials.json, service-account.json, secrets.yaml, deploy/token.txt, key
 * files): never read and never part of a root, so their content cannot reach brain search or the agent read tools.
 */
export function isSecretLikeName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return SECRET_WORD.test(name) || SECRET_ANYWHERE.test(name)
    || (dot >= 0 && SECRET_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase()));
}

/** File text that holds a credential whatever its name; such a file is skipped like a secret-like name. */
export function isSecretLikeText(text: string): boolean {
  return SECRET_CONTENT.some((pattern) => pattern.test(text)) || (SERVICE_ACCOUNT.test(text) && text.includes("\"private_key"));
}

export const MATRIX_FILE_EXTENSIONS_DEFAULT: readonly string[] = [
  "css", "go", "html", "js", "json", "jsx", "md", "mdx", "py", "rs", "sh", "sql", "toml", "ts", "tsx", "txt", "yaml",
  "yml",
];

/** The normalized home-relative root ("projects/app"), or null when it is not allowed. */
export function normalizeMatrixRoot(raw: string): string | null {
  if (raw.length === 0 || raw.length > L.listItemMaxChars || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith("/")) return null;
  const segments = raw.replace(/\/+$/, "").split("/");
  const refused = (segment: string) => segment === "" || segment === ".." || isSkippedName(segment) || isSecretLikeName(segment);
  if (segments.some(refused)) return null;
  if (PROTECTED_FIRST_SEGMENTS.includes(segments[0]!)) return null;
  const root = segments.join("/");
  if (DENIED_PREFIXES.some((prefix) => root === prefix || root.startsWith(`${prefix}/`) || prefix.startsWith(`${root}/`))) {
    return null;
  }
  return root;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

const uniqueList = (item: z.ZodType<string>, min: number, max: number) => z.array(item).min(min).max(max)
  .refine((values) => new Set(values).size === values.length).transform(sortedUnique);

const rootSchema = z.string().transform((value, ctx) => {
  const root = normalizeMatrixRoot(value);
  if (root === null) {
    ctx.addIssue({ code: "custom", message: "invalid root" });
    return z.NEVER;
  }
  return root;
});
const extensionSchema = z.string().max(17).transform((value) => value.replace(/^\./, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9]{1,16}$/));
const tagSchema = z.string().max(64).transform((value) => value.trim().replace(/^#/, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z][a-z0-9-]{1,40}$/));
const chatIdSchema = z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/);

const NotesConfigSchema = z.object({
  folders: uniqueList(tagSchema, 0, BRAIN_MATRIX_LIMITS.noteFolders).default([]),
}).strict();
const FilesConfigSchema = z.object({
  roots: uniqueList(rootSchema, 1, L.matrixFileRoots),
  extensions: uniqueList(extensionSchema, 1, L.matrixFileExtensions).default([...MATRIX_FILE_EXTENSIONS_DEFAULT]),
  maxFileBytes: z.number().int().min(1).max(L.matrixFileMaxBytesCeiling).default(L.matrixFileMaxBytesDefault),
}).strict().refine(({ roots }) => roots.every((root) => !roots.some((other) => root.startsWith(`${other}/`))));
const ChatConfigSchema = z.object({ chatIds: uniqueList(chatIdSchema, 1, L.matrixChats) }).strict();

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
  } catch (error: unknown) {
    throw new BrainFeatureError("source_config_invalid", { cause: error });
  }
  if (size > L.configMaxBytes) throw new BrainFeatureError("source_config_invalid");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BrainFeatureError("source_config_invalid", { cause: parsed.error });
  return parsed.data;
}

export function parseNotesConfig(raw: unknown): BrainMatrixNotesSourceConfig {
  return parseWith(NotesConfigSchema, raw);
}
export function parseFilesConfig(raw: unknown): BrainMatrixFilesSourceConfig {
  return parseWith(FilesConfigSchema, raw);
}
export function parseChatConfig(raw: unknown): BrainMatrixChatSourceConfig {
  return parseWith(ChatConfigSchema, raw);
}

function label(prefix: string, items: readonly string[]): string {
  const text = items.length === 0 ? prefix : `${prefix}: ${items.join(", ")}`;
  if (text.length <= 300) return text;
  const head = text.slice(0, 297);
  return `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head}...`;
}

export function identifyNotes(config: BrainMatrixNotesSourceConfig): { externalRef: string; label: string } {
  return { externalRef: "matrix_notes", label: label("Notes", config.folders) };
}
/** One files source per root set: the roots decide the identity, so the same roots connect to the same source. */
export function identifyFiles(config: BrainMatrixFilesSourceConfig): { externalRef: string; label: string } {
  const digest = createHash("sha256").update(JSON.stringify(config.roots)).digest("hex").slice(0, 32);
  return { externalRef: `matrix_files:${digest}`, label: label("Files", config.roots) };
}
export function identifyChats(config: BrainMatrixChatSourceConfig): { externalRef: string; label: string } {
  return { externalRef: "matrix_chat", label: `Chats (${config.chatIds.length})` };
}
