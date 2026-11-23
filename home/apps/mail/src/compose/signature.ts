/**
 * Per-account signatures, kept as plain text in the Mail app's private
 * key-value store (`MatrixOS.readData` / `writeData`). A signature is
 * inserted as escaped text below the standard `-- ` separator.
 */
import { textToHtml } from "../../../_shared/office-accounts/mail/text";

export const SIGNATURE_KEY = "compose-signatures";
export const MAX_SIGNATURE_CHARS = 2_000;
/** Accounts with a stored signature; more are dropped, oldest key first. */
export const MAX_SIGNATURE_ACCOUNTS = 50;
const MAX_ACCOUNT_ID_CHARS = 320;

export interface SignatureBridge {
  readData?(key: string): Promise<unknown>;
  writeData?(key: string, value: unknown): Promise<void>;
}

export interface SignatureStore {
  /** Reads stored signatures. Never rejects; a failed read keeps what is in memory. */
  load(): Promise<void>;
  get(accountId: string): string;
  /** Stores the signature (empty removes it). Rejects when the store cannot be written. */
  save(accountId: string, text: string): Promise<void>;
}

function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, MAX_SIGNATURE_CHARS);
}

/** Only string values under sane keys survive. */
export function cleanSignatures(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_SIGNATURE_ACCOUNTS) break;
    if (!key || key.length > MAX_ACCOUNT_ID_CHARS || typeof text !== "string") continue;
    const clean = cleanText(text);
    if (!clean.trim()) continue;
    out[key] = clean;
    count += 1;
  }
  return out;
}

export function createSignatureStore(bridge: SignatureBridge | undefined): SignatureStore {
  let signatures: Record<string, string> = {};
  return {
    async load() {
      if (!bridge?.readData) return;
      try {
        signatures = { ...cleanSignatures(await bridge.readData(SIGNATURE_KEY)), ...signatures };
      } catch (error: unknown) {
        console.warn(`[mail] signature.load.failed (${error instanceof Error ? error.name : typeof error})`);
      }
    },
    get(accountId) {
      return signatures[accountId] ?? "";
    },
    async save(accountId, text) {
      const next = { ...signatures };
      delete next[accountId];
      const clean = cleanText(text);
      if (clean.trim()) next[accountId] = clean;
      const keys = Object.keys(next);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SIGNATURE_ACCOUNTS))) delete next[key];
      signatures = next;
      if (bridge?.writeData) await bridge.writeData(SIGNATURE_KEY, next);
    },
  };
}

/** The signature block: a blank line, `-- `, then one div per line. Empty for a blank signature. */
export function signatureHtml(text: string): string {
  const clean = cleanText(text);
  if (!clean.trim()) return "";
  const lines = clean.split("\n").map((line) => `<div>${line ? textToHtml(line).replace(/&#39;/g, "'") : "<br>"}</div>`);
  return `<div><br></div><div>-- </div>${lines.join("")}`;
}

/** `bodyHtml` with the signature at the end, unless it already ends with it. */
export function appendSignature(bodyHtml: string, text: string): string {
  const block = signatureHtml(text);
  if (!block || bodyHtml.endsWith(block)) return bodyHtml;
  return `${bodyHtml}${block}`;
}
