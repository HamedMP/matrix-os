import { createHash } from "node:crypto";
import { CHAT_ELECTRON_PREVIEW_BASE_LABEL, ChatElectronPreviewLabelSchema } from "../../shared/chat-electron-preview";

export const MAX_SIGN_IN_SOURCE_BYTES = 64 * 1024;
const labelMarkup = (label: string) => `<span className="signin-eyebrow">${label}</span>`;
const original = Buffer.from(labelMarkup(CHAT_ELECTRON_PREVIEW_BASE_LABEL));

function reconstruct(base: Buffer, label: string): Buffer | null {
  if (base.length > MAX_SIGN_IN_SOURCE_BYTES || !ChatElectronPreviewLabelSchema.safeParse(label).success) return null;
  const start = base.indexOf(original);
  if (start < 0 || base.indexOf(original, start + original.length) !== -1) return null;
  return Buffer.concat([
    base.subarray(0, start), Buffer.from(labelMarkup(label)), base.subarray(start + original.length),
  ]);
}

export function deriveVerificationLabel(base: Buffer, candidate: Buffer): string | null {
  if (candidate.length > MAX_SIGN_IN_SOURCE_BYTES) return null;
  const matches = [...candidate.toString("utf8").matchAll(/<span className="signin-eyebrow">([^<]{1,55})<\/span>/g)];
  const label = matches.length === 1 ? matches[0]?.[1] : undefined;
  return label !== undefined && reconstruct(base, label)?.equals(candidate) ? label : null;
}

export function verifiedSignInSource(base: Buffer, label: string, sourceSha256: string, allowBaseline = false): Buffer {
  if (!allowBaseline && label === CHAT_ELECTRON_PREVIEW_BASE_LABEL) throw new Error("Unsupported preview label");
  const patched = reconstruct(base, label);
  if (!patched) throw new Error("Unsupported preview source");
  if (createHash("sha256").update(patched).digest("hex") !== sourceSha256) throw new Error("Preview source checksum mismatch");
  return patched;
}
