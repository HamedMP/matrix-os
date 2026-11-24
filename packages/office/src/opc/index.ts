/**
 * ZIP container and OPC package layer of the document engine.
 * Implements the contract in `../api/opc.ts`.
 */

export type {
  ContentTypeDefault,
  ContentTypeOverride,
  ContentTypes,
  CreatePackage,
  ListPartsOptions,
  NewRelationship,
  OpcModule,
  OpcPackage,
  OpenPackage,
  PartInfo,
  PartName,
  Relationship,
  RelationshipSource,
  ZipLimits,
} from "../api/opc.js";

export { createPackage, openPackage } from "./package.js";
export { DEFAULT_ZIP_LIMITS, resolveZipLimits } from "./limits.js";
export { findMainDocumentPart, findPartByRelationshipType } from "./main-document.js";

export {
  CONTENT_TYPES_NAMESPACE,
  CONTENT_TYPE_RELATIONSHIPS,
  CONTENT_TYPE_XML,
  ContentTypeTable,
} from "./content-types.js";
export {
  RELATIONSHIPS_NAMESPACE,
  RELATIONSHIP_TYPE_OFFICE_DOCUMENT,
  RELATIONSHIP_TYPE_OFFICE_DOCUMENT_STRICT,
  RelationshipSet,
} from "./relationships.js";
export {
  CONTENT_TYPES_PART,
  PACKAGE_RELS_PART,
  PACKAGE_ROOT,
  entryNameToPartName,
  isRelationshipsPartName,
  normalizePartName,
  partDirectory,
  partExtension,
  partNameKey,
  partNameToEntryName,
  partNamesEqual,
  relationshipsPartNameFor,
  relationshipsSourceOf,
  relativeTargetFor,
  resolveRelationshipTarget,
} from "./part-names.js";

export { crc32 } from "./crc32.js";
export { FIXED_DOS_DATE, FIXED_DOS_TIME, type ZipRecord } from "./zip-format.js";
export { parseZip, readRecord } from "./zip-reader.js";
export { buildZip, createRecord } from "./zip-writer.js";
