import { createConflictCopyPath, sanitizeConflictPeerId } from "./conflict.js";

const NUMBERED_CANDIDATES = 8;

function splitExtension(path: string): { base: string; ext: string } {
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  if (lastDot > lastSlash + 1) {
    return { base: path.slice(0, lastDot), ext: path.slice(lastDot) };
  }
  return { base: path, ext: "" };
}

/**
 * Ordered, distinct names for preserving a diverged local copy. The standard
 * conflict name comes first, then content-qualified and numbered variants so
 * repeat conflicts on the same day never collide, then a name without the
 * word "conflict" for owner policies that ignore conflict copies.
 */
export function conflictCopyCandidates(
  relPath: string,
  peerId: string,
  contentHash: string,
  date: Date,
): string[] {
  const shortHash = contentHash.replace(/^sha256:/, "").slice(0, 8);
  const qualifiedPeer = `${peerId}-${shortHash}`;
  const candidates = [
    createConflictCopyPath(relPath, peerId, date),
    createConflictCopyPath(relPath, qualifiedPeer, date),
  ];
  for (let n = 2; n <= NUMBERED_CANDIDATES; n++) {
    candidates.push(createConflictCopyPath(relPath, `${qualifiedPeer}-${n}`, date));
  }
  const { base, ext } = splitExtension(relPath);
  candidates.push(`${base} (${sanitizeConflictPeerId(peerId)} copy ${shortHash})${ext}`);
  return candidates;
}
