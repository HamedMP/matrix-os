import { createHash } from "node:crypto";
import { MacVerificationFilesMenuLabelSchema } from "@matrix-os/contracts";
import { MAX_SIGN_IN_SOURCE_BYTES } from "./source";

const original = 'label: "Move to Trash",';

function reconstruct(base: Buffer, label: string): Buffer | null {
  if (base.length > MAX_SIGN_IN_SOURCE_BYTES || !MacVerificationFilesMenuLabelSchema.safeParse(label).success) return null;
  const start = base.indexOf(original);
  if (start < 0 || base.indexOf(original, start + original.length) >= 0) return null;
  return Buffer.concat([
    base.subarray(0, start),
    Buffer.from(`label: "${label}",`),
    base.subarray(start + original.length),
  ]);
}

export function deriveFilesTrashLabel(base: Buffer, candidate: Buffer): string | null {
  if (candidate.length > MAX_SIGN_IN_SOURCE_BYTES) return null;
  const start = base.indexOf(original);
  if (start < 0) return null;
  const label = /^label: "([^"]{1,55})",/.exec(
    candidate.subarray(start, start + 66).toString("utf8"),
  )?.[1];
  return label !== undefined && reconstruct(base, label)?.equals(candidate) ? label : null;
}

export function verifiedFilesTrashSource(base: Buffer, label: string, sourceSha256: string): Buffer {
  const candidate = reconstruct(base, label);
  if (!candidate) throw new Error("Unsupported Files preview source");
  if (createHash("sha256").update(candidate).digest("hex") !== sourceSha256) {
    throw new Error("Files preview source checksum mismatch");
  }
  return candidate;
}
