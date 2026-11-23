/**
 * Images of a document, read ahead of the comparison: the comparison itself
 * is synchronous, and it needs the bytes of an image both to tell two
 * pictures apart and to carry a picture of the revised document over.
 */

import type { PartName } from "../../api/opc.js";
import { OfficeError, isOfficeError } from "../../errors.js";
import { crc32, partNameKey } from "../../opc/index.js";
import type { DocxIndex } from "../internal.js";

export interface MediaItem {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  /** Extension of the part name without the dot, lower case; `bin` when it has none. */
  readonly extension: string;
  /** Identifies the content: equal for equal bytes. */
  readonly signature: string;
  /** The relationship type that points at the image. */
  readonly relationshipType: string;
}

/** Images by the part that refers to them and the relationship id it uses. */
export type MediaTable = Map<string, MediaItem>;

/** Most images read from one document. */
const MAX_IMAGES = 2000;

export function mediaKey(part: PartName, relationshipId: string): string {
  return `${partNameKey(part)}\n${relationshipId}`;
}

const STORY_PARTS: ReadonlySet<string> = new Set(["document", "header", "footer", "footnotes", "endnotes"]);

/** Reads every image the story parts of a document refer to. */
export async function readMedia(index: DocxIndex): Promise<MediaTable> {
  const table: MediaTable = new Map();
  const pkg = index.package;
  const byTarget = new Map<string, Omit<MediaItem, "relationshipType">>();
  for (const slot of index.store.list()) {
    if (!STORY_PARTS.has(slot.kind) || !pkg.hasPart(slot.name)) continue;
    for (const relationship of pkg.getRelationships(slot.name)) {
      if (relationship.targetMode !== "Internal" || !relationship.type.endsWith("/image")) continue;
      let target: PartName;
      try {
        target = pkg.resolveTarget(slot.name, relationship.target);
      } catch (error) {
        // A target that leaves the package names no image; anything else is a real failure.
        if (isOfficeError(error, "invalid_argument")) continue;
        throw error;
      }
      if (!pkg.hasPart(target)) continue;
      const key = partNameKey(target);
      let item = byTarget.get(key);
      if (item === undefined) {
        if (byTarget.size >= MAX_IMAGES) {
          throw new OfficeError("limit_exceeded", "the document has too many images to compare", { details: { limit: MAX_IMAGES } });
        }
        const bytes = await pkg.getPartBytes(target);
        const dot = target.lastIndexOf(".");
        const extension = dot > target.lastIndexOf("/") ? target.slice(dot + 1).toLowerCase() : "bin";
        item = {
          bytes,
          contentType: pkg.getContentType(target),
          extension: /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin",
          signature: `${crc32(bytes).toString(16)}:${bytes.length}`,
        };
        byTarget.set(key, item);
      }
      table.set(mediaKey(slot.name, relationship.id), { ...item, relationshipType: relationship.type });
    }
  }
  return table;
}
