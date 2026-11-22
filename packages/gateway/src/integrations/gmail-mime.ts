import { randomBytes } from "node:crypto";

/**
 * RFC 5322 / MIME message builder for Gmail drafts.
 *
 * Every header value is either validated (addresses, message ids, attachment
 * metadata) or stripped of line breaks and control characters (subject and
 * display names), so caller text can never start a new header or part.
 */

export interface MimeAddress { address: string; name?: string }
export interface MimeAttachment { filename: string; mimeType: string; contentBase64: string }
export interface MimeMessageInput {
  to?: readonly MimeAddress[];
  cc?: readonly MimeAddress[];
  bcc?: readonly MimeAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments?: readonly MimeAttachment[];
  inReplyTo?: string;
  references?: readonly string[];
}
export interface MimeBuildOptions {
  /** Boundary factory; defaults to a random boundary per multipart entity. */
  boundary?: () => string;
}
export type MimeBuildErrorReason = "invalid_address" | "invalid_message_id" | "invalid_attachment" | "too_large";

export class MimeBuildError extends Error {
  readonly reason: MimeBuildErrorReason;
  constructor(reason: MimeBuildErrorReason) {
    super(`Mail message rejected: ${reason}`);
    this.name = "MimeBuildError";
    this.reason = reason;
  }
}

/** Upper bound for the assembled message before base64url encoding. */
export const MAX_RAW_MESSAGE_BYTES = 256 * 1024;

const CRLF = "\r\n";
const MAX_LINE = 78;
const BASE64_LINE = 76;
/** 75-character encoded word = 12 characters of framing + 63 of base64 = 45 bytes. */
const ENCODED_WORD_BYTES = 45;
const PARAMETER_CHUNK = 60;

// Dot-atom local part and a hostname: no whitespace, brackets, commas,
// semicolons, quotes or control characters can survive into a header.
const SAFE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
// Printable ASCII between angle brackets, excluding the brackets themselves.
const SAFE_MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,995}>$/;
const SAFE_FILENAME = /^[^/\\"\x00-\x1f\x7f-\x9f\u2028\u2029]{1,255}$/;
const SAFE_MIME_TYPE = /^[\w.+-]{1,63}\/[\w.+-]{1,63}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Line breaks of every kind plus C0/C1 controls.
const HEADER_UNSAFE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const PLAIN_PHRASE = /^[\x20-\x7e]*$/;
const PLAIN_SUBJECT = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

export function sanitizeHeaderText(value: string): string {
  return value.replace(HEADER_UNSAFE, "");
}

export function wrapBase64(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += BASE64_LINE) lines.push(base64.slice(i, i + BASE64_LINE));
  return lines.join(CRLF);
}

export function toBase64Url(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}

/** RFC 2047 `B` encoded words of at most 75 characters, never splitting a character. */
export function encodeHeaderWords(text: string): string[] {
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let size = 0;
  const flush = () => {
    words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString("base64")}?=`);
    chunk = []; size = 0;
  };
  for (const char of text) {
    const bytes = Buffer.from(char, "utf8");
    if (size + bytes.length > ENCODED_WORD_BYTES) flush();
    chunk.push(bytes); size += bytes.length;
  }
  if (size > 0 || words.length === 0) flush();
  return words;
}

/** Joins tokens with single spaces, folding before a token that would pass 78 columns. */
function foldHeader(name: string, tokens: readonly string[]): string {
  const lines: string[] = [];
  let current = `${name}:`;
  for (const token of tokens) {
    if (current.length + 1 + token.length <= MAX_LINE) {
      current += ` ${token}`;
    } else {
      lines.push(current);
      current = ` ${token}`;
    }
  }
  lines.push(current);
  return lines.join(CRLF);
}

function addressTokens(recipient: MimeAddress): string[] {
  const address = recipient.address;
  if (typeof address !== "string" || address.length > 254 || !SAFE_ADDRESS.test(address)) {
    throw new MimeBuildError("invalid_address");
  }
  const name = typeof recipient.name === "string" ? sanitizeHeaderText(recipient.name).trim() : "";
  if (name === "") return [address];
  if (PLAIN_PHRASE.test(name) && !name.includes("=?")) {
    return [`"${name.replace(/[\\"]/g, "\\$&")}" <${address}>`];
  }
  return [...encodeHeaderWords(name), `<${address}>`];
}

function addressHeader(name: string, recipients: readonly MimeAddress[] | undefined): string[] {
  if (!recipients?.length) return [];
  const tokens = recipients.flatMap((recipient, index) => {
    const parts = addressTokens(recipient);
    if (index < recipients.length - 1) parts[parts.length - 1] += ",";
    return parts;
  });
  return [foldHeader(name, tokens)];
}

function subjectHeader(subject: string): string {
  const clean = sanitizeHeaderText(subject);
  if (clean === "") return "Subject:";
  if (PLAIN_SUBJECT.test(clean) && !clean.includes("=?")) return foldHeader("Subject", clean.split(" "));
  return foldHeader("Subject", encodeHeaderWords(clean));
}

function messageId(value: string): string {
  if (typeof value !== "string" || !SAFE_MESSAGE_ID.test(value)) throw new MimeBuildError("invalid_message_id");
  return value;
}

/** A MIME parameter: quoted when short and ASCII, otherwise RFC 2231 with continuations. */
function parameterTokens(name: string, value: string): string[] {
  if (value.length <= PARAMETER_CHUNK && PLAIN_PHRASE.test(value)) return [`${name}="${value}"`];
  const encoded = [...Buffer.from(value, "utf8")].map((byte) => {
    const char = String.fromCharCode(byte);
    return byte < 0x80 && ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  });
  const chunks: string[] = [];
  let current = "UTF-8''";
  for (const piece of encoded) {
    if (current.length + piece.length > PARAMETER_CHUNK) { chunks.push(current); current = ""; }
    current += piece;
  }
  chunks.push(current);
  if (chunks.length === 1) return [`${name}*=${chunks[0]}`];
  return chunks.map((chunk, index) => `${name}*${index}*=${chunk}`);
}

function withSeparators(tokens: string[]): string[] {
  return tokens.map((token, index) => (index < tokens.length - 1 ? `${token};` : token));
}

function boundaryFactory(options: MimeBuildOptions): () => string {
  // "=_" cannot occur inside base64 bodies or the fixed part headers.
  return options.boundary ?? (() => `=_mx_${randomBytes(16).toString("hex")}`);
}

const canonicalLines = (text: string) => text.replace(/\r\n|\r|\n/g, CRLF);

function textPart(subtype: "plain" | "html", content: string): string {
  return [
    `Content-Type: text/${subtype}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(canonicalLines(content), "utf8").toString("base64")),
  ].join(CRLF);
}

function attachmentPart(attachment: MimeAttachment): string {
  const { filename, mimeType, contentBase64 } = attachment;
  if (typeof filename !== "string" || !SAFE_FILENAME.test(filename)
    || typeof mimeType !== "string" || !SAFE_MIME_TYPE.test(mimeType)
    || typeof contentBase64 !== "string" || !BASE64.test(contentBase64)) {
    throw new MimeBuildError("invalid_attachment");
  }
  return [
    foldHeader("Content-Type", withSeparators([mimeType, ...parameterTokens("name", filename)])),
    foldHeader("Content-Disposition", withSeparators(["attachment", ...parameterTokens("filename", filename)])),
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(contentBase64),
  ].join(CRLF);
}

function multipart(subtype: "alternative" | "mixed", boundary: string, entities: readonly string[]): { header: string; body: string } {
  return {
    header: foldHeader("Content-Type", [`multipart/${subtype};`, `boundary="${boundary}"`]),
    body: `${entities.map((entity) => `--${boundary}${CRLF}${entity}${CRLF}`).join("")}--${boundary}--${CRLF}`,
  };
}

function estimatedBytes(input: MimeMessageInput): number {
  const text = Buffer.byteLength(String(input.bodyText ?? ""), "utf8") + Buffer.byteLength(String(input.bodyHtml ?? ""), "utf8");
  const files = (input.attachments ?? []).reduce((sum, file) => sum + String(file?.contentBase64 ?? "").length, 0);
  return Math.ceil(text * 4 / 3) + files;
}

/** Builds the complete message as CRLF-delimited ASCII text. */
export function buildMimeMessage(input: MimeMessageInput, options: MimeBuildOptions = {}): string {
  if (estimatedBytes(input) > MAX_RAW_MESSAGE_BYTES) throw new MimeBuildError("too_large");
  const nextBoundary = boundaryFactory(options);
  const headers = [
    ...addressHeader("To", input.to),
    ...addressHeader("Cc", input.cc),
    ...addressHeader("Bcc", input.bcc),
    subjectHeader(String(input.subject ?? "")),
    ...(input.inReplyTo !== undefined ? [foldHeader("In-Reply-To", [messageId(input.inReplyTo)])] : []),
    ...(input.references?.length ? [foldHeader("References", input.references.map(messageId))] : []),
    "MIME-Version: 1.0",
  ];
  const attachments = input.attachments ?? [];
  const outerBoundary = nextBoundary();
  const alternativeBoundary = attachments.length > 0 ? nextBoundary() : outerBoundary;
  const alternative = multipart("alternative", alternativeBoundary, [
    textPart("plain", String(input.bodyText ?? "")),
    textPart("html", String(input.bodyHtml ?? "")),
  ]);
  let top = alternative;
  if (attachments.length > 0) {
    top = multipart("mixed", outerBoundary, [
      `${alternative.header}${CRLF}${CRLF}${alternative.body}`,
      ...attachments.map(attachmentPart),
    ]);
  }
  const message = `${[...headers, top.header].join(CRLF)}${CRLF}${CRLF}${top.body}`;
  if (message.length > MAX_RAW_MESSAGE_BYTES) throw new MimeBuildError("too_large");
  return message;
}

/** The `raw` field for the Gmail API: the message as unpadded base64url. */
export function buildGmailRaw(input: MimeMessageInput, options: MimeBuildOptions = {}): string {
  return toBase64Url(buildMimeMessage(input, options));
}
