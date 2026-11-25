/** Finding parts through relationship types, starting with the main document part. */

import type { OpcPackage, PartName, RelationshipSource } from "../api/opc.js";
import { RELATIONSHIP_TYPE_OFFICE_DOCUMENT, RELATIONSHIP_TYPE_OFFICE_DOCUMENT_STRICT } from "./relationships.js";

/**
 * The first existing part that `source` points at with an internal
 * relationship of one of the given types, or null.
 */
export function findPartByRelationshipType(
  pkg: OpcPackage,
  source: RelationshipSource,
  ...types: string[]
): PartName | null {
  for (const type of types) {
    for (const relationship of pkg.getRelationshipsByType(source, type)) {
      if (relationship.targetMode !== "Internal") continue;
      const target = pkg.resolveTarget(source, relationship.target);
      if (pkg.hasPart(target)) return target;
    }
  }
  return null;
}

/**
 * The main document part of a package (`/word/document.xml`, `/xl/workbook.xml`,
 * …): the target of the package-level `officeDocument` relationship, in its
 * transitional or strict form. Null when the package declares none.
 */
export function findMainDocumentPart(pkg: OpcPackage): PartName | null {
  return findPartByRelationshipType(
    pkg,
    "/",
    RELATIONSHIP_TYPE_OFFICE_DOCUMENT,
    RELATIONSHIP_TYPE_OFFICE_DOCUMENT_STRICT,
  );
}
