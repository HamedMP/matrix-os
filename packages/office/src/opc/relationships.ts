/** Relationship parts (`_rels/*.rels`): parse, edit with id allocation, and write. */

import type { NewRelationship, Relationship } from "../api/opc.js";
import { encodeUtf8 } from "./bytes.js";
import { fault } from "./errors.js";
import { assertXmlText, decodeXmlBytes, escapeXmlAttribute, scanStartTags } from "./xml-lite.js";

export const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Relationship type of the main document part, transitional and strict forms. */
export const RELATIONSHIP_TYPE_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
export const RELATIONSHIP_TYPE_OFFICE_DOCUMENT_STRICT =
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function numberOfId(id: string): number {
  const match = /^rId(\d{1,15})$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/**
 * The relationships of one source, in document order. Lookups by id go through
 * an index so a part with very many relationships still parses in linear time;
 * both collections hold exactly the relationships of the part.
 */
export class RelationshipSet {
  private readonly items: Relationship[] = [];
  private readonly byId = new Map<string, Relationship>();
  /** Highest `rIdN` number ever seen, so an id is not handed out twice. */
  private highest = 0;

  /** Parses the bytes of a relationships part. */
  static parse(bytes: Uint8Array): RelationshipSet {
    const set = new RelationshipSet();
    const tags = scanStartTags(decodeXmlBytes(bytes));
    if (tags[0]?.localName !== "Relationships") {
      throw fault("invalid_relationships", "relationships part does not start with a Relationships element");
    }
    for (const tag of tags) {
      if (tag.depth !== 1 || tag.localName !== "Relationship") continue;
      const id = tag.attributes.get("Id");
      const type = tag.attributes.get("Type");
      const target = tag.attributes.get("Target");
      if (!id || type === undefined || target === undefined) {
        throw fault("invalid_relationships", "Relationship entry lacks Id, Type or Target");
      }
      if (set.byId.has(id)) {
        throw fault("invalid_relationships", "relationships part repeats an Id");
      }
      const external = tag.attributes.get("TargetMode")?.toLowerCase() === "external";
      set.insert({ id, type, target, targetMode: external ? "External" : "Internal" });
    }
    return set;
  }

  get size(): number {
    return this.items.length;
  }

  /** Detached copies in document order. */
  list(): Relationship[] {
    return this.items.map((item) => ({ ...item }));
  }

  get(id: string): Relationship | null {
    const found = this.byId.get(id);
    return found ? { ...found } : null;
  }

  byType(type: string): Relationship[] {
    return this.items.filter((item) => item.type === type).map((item) => ({ ...item }));
  }

  /** The next unused `rIdN`: one above the highest number this set has held. */
  nextId(): string {
    return `rId${this.highest + 1}`;
  }

  add(relationship: NewRelationship): Relationship {
    if (typeof relationship.type !== "string" || relationship.type === "") {
      throw fault("invalid_value", "relationship type is empty");
    }
    if (typeof relationship.target !== "string" || relationship.target === "") {
      throw fault("invalid_value", "relationship target is empty");
    }
    assertXmlText(relationship.type, "relationship type");
    assertXmlText(relationship.target, "relationship target");
    const targetMode = relationship.targetMode ?? "Internal";
    if (targetMode !== "Internal" && targetMode !== "External") {
      throw fault("invalid_value", "relationship target mode must be Internal or External");
    }
    const id = relationship.id ?? this.nextId();
    // Ids are XML names: a letter or underscore first, then name characters, no colon.
    if (!/^[A-Za-z_][\w.-]*$/.test(id)) {
      throw fault("invalid_value", "relationship id is not a valid XML id");
    }
    if (this.byId.has(id)) {
      throw fault("duplicate_relationship", `relationship id "${id}" is already in use`);
    }
    const added: Relationship = { id, type: relationship.type, target: relationship.target, targetMode };
    this.insert(added);
    return { ...added };
  }

  /** Returns false when the id did not exist. */
  remove(id: string): boolean {
    const found = this.byId.get(id);
    if (!found) return false;
    this.byId.delete(id);
    this.items.splice(this.items.indexOf(found), 1);
    return true;
  }

  private insert(relationship: Relationship): void {
    this.items.push(relationship);
    this.byId.set(relationship.id, relationship);
    this.highest = Math.max(this.highest, numberOfId(relationship.id));
  }

  serialize(): Uint8Array {
    let xml = `${XML_DECLARATION}<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`;
    for (const item of this.items) {
      xml += `<Relationship Id="${escapeXmlAttribute(item.id)}" Type="${escapeXmlAttribute(item.type)}" Target="${escapeXmlAttribute(item.target)}"`;
      if (item.targetMode === "External") xml += ' TargetMode="External"';
      xml += "/>";
    }
    return encodeUtf8(`${xml}</Relationships>`);
  }
}
