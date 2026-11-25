/**
 * The OPC package: parts, content types and relationships over a ZIP container.
 *
 * Every entry of the opened archive stays attached to its original stored
 * record. `save()` hands that record straight back to the writer unless the
 * part was set, its relationships changed, or (for `[Content_Types].xml`) a
 * content type changed, so untouched parts keep their exact compressed bytes.
 */

import type {
  ContentTypes,
  ListPartsOptions,
  NewRelationship,
  OpcPackage,
  PartInfo,
  PartName,
  Relationship,
  RelationshipSource,
  ZipLimits,
} from "../api/opc.js";
import { encodeUtf8 } from "./bytes.js";
import { CONTENT_TYPE_RELATIONSHIPS, ContentTypeTable } from "./content-types.js";
import { entryNameKey } from "./entry-names.js";
import { asPackageDamage, fault } from "./errors.js";
import {
  CONTENT_TYPES_PART,
  PACKAGE_RELS_PART,
  PACKAGE_ROOT,
  assertStorablePartName,
  isRelationshipsPartName,
  normalizePartName,
  partNameKey,
  relationshipsPartNameFor,
  resolveRelationshipTarget,
} from "./part-names.js";
import { RelationshipSet } from "./relationships.js";
import { decodeXmlBytes } from "./xml-lite.js";
import type { ZipRecord } from "./zip-format.js";
import { parseZip, readRecord } from "./zip-reader.js";
import { buildZip, createRecord } from "./zip-writer.js";

type SlotKind = "content-types" | "relationships" | "part" | "directory";

/** One archive entry, or one part added since open. */
interface Slot {
  readonly kind: SlotKind;
  /** Part name in its stored casing; the raw entry name for a directory entry. */
  readonly name: string;
  readonly entryName: string;
  /** The record read from the archive, or null for something added since open. */
  readonly original: ZipRecord | null;
  /** Parsed relationships, for a relationships slot. */
  relationships: RelationshipSet | null;
  modified: boolean;
  /** Current content of a modified slot. Serialized lazily for relationships and content types. */
  data: Uint8Array | null;
  /** Inflated original content, kept after the first read. */
  inflated: Promise<Uint8Array> | null;
  /** Compressed form of `data`, kept until the slot changes again. */
  packed: Promise<ZipRecord> | null;
}

const CONTENT_TYPES_KEY = partNameKey(CONTENT_TYPES_PART);
const PACKAGE_RELS_KEY = partNameKey(PACKAGE_RELS_PART);
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function newSlot(kind: SlotKind, name: string, entryName: string, original: ZipRecord | null): Slot {
  return {
    kind,
    name,
    entryName,
    original,
    relationships: kind === "relationships" ? new RelationshipSet() : null,
    modified: original === null,
    data: null,
    inflated: null,
    packed: null,
  };
}

function touch(slot: Slot): void {
  slot.modified = true;
  slot.data = null;
  slot.packed = null;
}

class Package implements OpcPackage {
  /**
   * Slots by part-name key, in archive order followed by insertion order.
   * Starts with at most `maxEntries` slots and grows only through `setPart`
   * and `addRelationship`, so its size is the caller's own document.
   */
  private readonly slots = new Map<string, Slot>();
  private readonly contentTypes: ContentTypeTable;
  private readonly contentTypesSlot: Slot;

  constructor(slots: Iterable<[string, Slot]>, contentTypesSlot: Slot, contentTypes: ContentTypeTable) {
    for (const [key, slot] of slots) this.slots.set(key, slot);
    this.contentTypesSlot = contentTypesSlot;
    this.contentTypes = contentTypes;
  }

  listParts(options: ListPartsOptions = {}): PartInfo[] {
    const parts: PartInfo[] = [];
    for (const slot of this.slots.values()) {
      if (slot.kind === "part" || (slot.kind === "relationships" && options.includeRelationships === true)) {
        parts.push({
          name: slot.name,
          contentType: this.contentTypes.typeOf(slot.name),
          size: this.currentData(slot)?.length ?? slot.original?.uncompressedSize ?? 0,
          isRelationships: slot.kind === "relationships",
          modified: slot.modified,
        });
      }
    }
    return parts;
  }

  hasPart(name: PartName): boolean {
    return this.findPart(name) !== null;
  }

  async getPartBytes(name: PartName): Promise<Uint8Array> {
    const slot = this.findPart(name);
    if (!slot) {
      throw fault("missing_part", `package has no part "${normalizePartName(name)}"`);
    }
    return this.contentOf(slot);
  }

  async getPartText(name: PartName): Promise<string> {
    return decodeXmlBytes(await this.getPartBytes(name));
  }

  setPart(name: PartName, data: Uint8Array | string, contentType?: string): void {
    const partName = normalizePartName(name);
    const key = partNameKey(partName);
    if (key === CONTENT_TYPES_KEY || isRelationshipsPartName(partName)) {
      throw fault("not_allowed", "content types and relationships parts are changed through their own methods");
    }
    if (typeof data !== "string" && !(data instanceof Uint8Array)) {
      throw fault("invalid_value", "part data must be a string or a Uint8Array");
    }
    const existing = this.slots.get(key);
    // An existing part came out of the archive, so only a new name needs to prove it can be stored.
    if (!existing) assertStorablePartName(partName);
    if (contentType === undefined) {
      if (!existing && this.contentTypes.typeOf(partName) === null) {
        throw fault("not_allowed", `a content type is required for new part "${partName}"`);
      }
    } else if (this.contentTypes.assign(existing?.name ?? partName, contentType)) {
      touch(this.contentTypesSlot);
    }
    const slot = existing ?? newSlot("part", partName, partName.slice(1), null);
    touch(slot);
    slot.data = typeof data === "string" ? encodeUtf8(data) : data;
    slot.inflated = null;
    if (!existing) this.slots.set(key, slot);
  }

  removePart(name: PartName): boolean {
    const partName = normalizePartName(name);
    const key = partNameKey(partName);
    if (key === CONTENT_TYPES_KEY || isRelationshipsPartName(partName)) {
      throw fault("not_allowed", "content types and relationships parts cannot be removed directly");
    }
    if (!this.slots.delete(key)) return false;
    const relsName = relationshipsPartNameFor(partName);
    this.slots.delete(partNameKey(relsName));
    // Both Overrides go: one left for a part that is no longer written makes the package invalid.
    const removedOverride = this.contentTypes.removeOverride(partName);
    const removedRelsOverride = this.contentTypes.removeOverride(relsName);
    if (removedOverride || removedRelsOverride) touch(this.contentTypesSlot);
    return true;
  }

  getContentType(name: PartName): string | null {
    return this.contentTypes.typeOf(normalizePartName(name));
  }

  getContentTypes(): ContentTypes {
    return this.contentTypes.snapshot();
  }

  setDefaultContentType(extension: string, contentType: string): void {
    if (this.contentTypes.setDefault(extension, contentType)) touch(this.contentTypesSlot);
  }

  getRelationships(source: RelationshipSource): Relationship[] {
    return this.relationshipsOf(source)?.list() ?? [];
  }

  getRelationship(source: RelationshipSource, id: string): Relationship | null {
    return this.relationshipsOf(source)?.get(id) ?? null;
  }

  getRelationshipsByType(source: RelationshipSource, type: string): Relationship[] {
    return this.relationshipsOf(source)?.byType(type) ?? [];
  }

  addRelationship(source: RelationshipSource, relationship: NewRelationship): Relationship {
    const relsName = this.relationshipsPartOf(source);
    if (source !== PACKAGE_ROOT && !this.findPart(source)) {
      throw fault("missing_part", `package has no part "${normalizePartName(source)}"`);
    }
    const key = partNameKey(relsName);
    const existing = this.slots.get(key);
    const slot = existing ?? newSlot("relationships", relsName, relsName.slice(1), null);
    const added = (slot.relationships as RelationshipSet).add(relationship);
    touch(slot);
    if (!existing) {
      this.slots.set(key, slot);
      if (
        this.contentTypes.defaultFor("rels") === null &&
        this.contentTypes.setDefault("rels", CONTENT_TYPE_RELATIONSHIPS)
      ) {
        touch(this.contentTypesSlot);
      }
    }
    return added;
  }

  removeRelationship(source: RelationshipSource, id: string): boolean {
    const key = partNameKey(this.relationshipsPartOf(source));
    const slot = this.slots.get(key);
    if (!slot?.relationships?.remove(id)) return false;
    touch(slot);
    // A relationships part that was created since open and is empty again is not written.
    if (slot.original === null && slot.relationships.size === 0) this.slots.delete(key);
    return true;
  }

  resolveTarget(source: RelationshipSource, target: string): PartName {
    return resolveRelationshipTarget(source, target);
  }

  async save(): Promise<Uint8Array> {
    const ordered: Slot[] = [this.contentTypesSlot];
    const packageRels = this.slots.get(PACKAGE_RELS_KEY);
    if (packageRels) ordered.push(packageRels);
    for (const slot of this.slots.values()) {
      if (slot !== this.contentTypesSlot && slot !== packageRels) ordered.push(slot);
    }
    const records: ZipRecord[] = [];
    for (const slot of ordered) records.push(await this.recordOf(slot));
    return buildZip(records);
  }

  /** A slot that callers may address as a part: an ordinary part or a relationships part. */
  private findPart(name: PartName): Slot | null {
    const slot = this.slots.get(partNameKey(name));
    return slot && (slot.kind === "part" || slot.kind === "relationships") ? slot : null;
  }

  private relationshipsPartOf(source: RelationshipSource): PartName {
    if (source === PACKAGE_ROOT) return PACKAGE_RELS_PART;
    const partName = normalizePartName(source);
    if (partNameKey(partName) === CONTENT_TYPES_KEY || isRelationshipsPartName(partName)) {
      throw fault("not_allowed", "content types and relationships parts cannot own relationships");
    }
    return relationshipsPartNameFor(partName);
  }

  private relationshipsOf(source: RelationshipSource): RelationshipSet | null {
    return this.slots.get(partNameKey(this.relationshipsPartOf(source)))?.relationships ?? null;
  }

  /** Content of a slot that changed since open, or null when the original record still stands. */
  private currentData(slot: Slot): Uint8Array | null {
    if (!slot.modified) return null;
    if (slot.data === null) {
      if (slot.kind === "content-types") slot.data = this.contentTypes.serialize();
      else if (slot.relationships) slot.data = slot.relationships.serialize();
      else slot.data = new Uint8Array(0);
    }
    return slot.data;
  }

  private contentOf(slot: Slot): Promise<Uint8Array> {
    const current = this.currentData(slot);
    if (current) return Promise.resolve(current);
    // Kept inflated data is bounded: its sum cannot pass the declared total that open checked.
    slot.inflated ??= readRecord(slot.original as ZipRecord);
    return slot.inflated;
  }

  private recordOf(slot: Slot): Promise<ZipRecord> {
    const current = this.currentData(slot);
    if (!current) return Promise.resolve(slot.original as ZipRecord);
    slot.packed ??= createRecord(slot.entryName, current);
    return slot.packed;
  }
}

function isOleCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= OLE_MAGIC.length && OLE_MAGIC.every((byte, index) => bytes[index] === byte);
}

function slotForRecord(record: ZipRecord): [string, Slot] {
  if (record.name.endsWith("/")) {
    return [`dir:${entryNameKey(record.name)}`, newSlot("directory", record.name, record.name, record)];
  }
  const partName = asPackageDamage("unsafe_entry_name", "archive entry name is not a valid part name", () =>
    normalizePartName(record.name),
  );
  const key = partNameKey(partName);
  let kind: SlotKind = "part";
  if (key === CONTENT_TYPES_KEY) kind = "content-types";
  else if (isRelationshipsPartName(partName)) kind = "relationships";
  return [key, newSlot(kind, partName, record.name, record)];
}

export async function openPackage(bytes: Uint8Array, limits?: Partial<ZipLimits>): Promise<OpcPackage> {
  if (!(bytes instanceof Uint8Array)) {
    throw fault("invalid_value", "package bytes must be a Uint8Array");
  }
  if (isOleCompoundFile(bytes)) {
    throw fault("ole_compound_file", "file is an OLE compound file: an encrypted or legacy binary document");
  }
  const { records } = parseZip(bytes, limits);
  // Bounded by `maxEntries`, which parseZip enforced.
  const slots = new Map<string, Slot>();
  for (const record of records) {
    const [key, slot] = slotForRecord(record);
    if (slots.has(key)) {
      throw fault("duplicate_entry", `archive contains part "${slot.name}" more than once`);
    }
    slots.set(key, slot);
  }

  const contentTypesSlot = slots.get(CONTENT_TYPES_KEY);
  if (!contentTypesSlot?.original) {
    throw fault("invalid_content_types", "package has no [Content_Types].xml");
  }
  const contentTypes = ContentTypeTable.parse(await readRecord(contentTypesSlot.original));
  for (const slot of slots.values()) {
    if (slot.kind !== "relationships" || !slot.original) continue;
    slot.relationships = RelationshipSet.parse(await readRecord(slot.original));
  }
  return new Package(slots, contentTypesSlot, contentTypes);
}

export function createPackage(): OpcPackage {
  const contentTypesSlot = newSlot("content-types", CONTENT_TYPES_PART, CONTENT_TYPES_PART.slice(1), null);
  return new Package([[CONTENT_TYPES_KEY, contentTypesSlot]], contentTypesSlot, ContentTypeTable.minimal());
}
