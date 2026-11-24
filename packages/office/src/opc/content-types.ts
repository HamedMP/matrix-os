/**
 * `[Content_Types].xml`: Default entries map an extension to a content type,
 * Override entries map one part name to a content type and win over a Default.
 */

import type { ContentTypeDefault, ContentTypeOverride, ContentTypes, PartName } from "../api/opc.js";
import { encodeUtf8 } from "./bytes.js";
import { asPackageDamage, fault } from "./errors.js";
import { normalizePartName, partExtension, partNameKey } from "./part-names.js";
import { decodeXmlBytes, escapeXmlAttribute, scanStartTags } from "./xml-lite.js";

export const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
export const CONTENT_TYPE_RELATIONSHIPS = "application/vnd.openxmlformats-package.relationships+xml";
export const CONTENT_TYPE_XML = "application/xml";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function normalizeExtension(extension: string): string {
  const bare = extension.startsWith(".") ? extension.slice(1) : extension;
  if (bare === "" || /[/\\\s]/.test(bare)) {
    throw fault("invalid_value", "content type extension is empty or malformed");
  }
  return bare.toLowerCase();
}

function requireContentType(contentType: string): string {
  if (typeof contentType !== "string" || contentType.trim() === "") {
    throw fault("invalid_value", "content type is empty");
  }
  return contentType;
}

/**
 * Mutable content-type table of one package. Both maps keep insertion order,
 * which is the order entries are written in, and both are bounded by what the
 * part-size limit lets a `[Content_Types].xml` hold plus what the caller adds.
 */
export class ContentTypeTable {
  private readonly defaults = new Map<string, ContentTypeDefault>();
  private readonly overrides = new Map<string, ContentTypeOverride>();

  /** A table with the two Defaults every package needs: `rels` and `xml`. */
  static minimal(): ContentTypeTable {
    const table = new ContentTypeTable();
    table.setDefault("rels", CONTENT_TYPE_RELATIONSHIPS);
    table.setDefault("xml", CONTENT_TYPE_XML);
    return table;
  }

  /** Parses the bytes of `[Content_Types].xml`. A repeated entry keeps its first value. */
  static parse(bytes: Uint8Array): ContentTypeTable {
    const table = new ContentTypeTable();
    const tags = scanStartTags(decodeXmlBytes(bytes));
    if (tags[0]?.localName !== "Types") {
      throw fault("invalid_content_types", "[Content_Types].xml does not start with a Types element");
    }
    for (const tag of tags) {
      if (tag.depth !== 1) continue;
      const contentType = tag.attributes.get("ContentType");
      if (tag.localName === "Default") {
        const extension = tag.attributes.get("Extension");
        if (extension === undefined || contentType === undefined) {
          throw fault("invalid_content_types", "Default entry lacks Extension or ContentType");
        }
        const key = asPackageDamage("invalid_content_types", "Default entry has a malformed Extension", () =>
          normalizeExtension(extension),
        );
        if (!table.defaults.has(key)) table.defaults.set(key, { extension: key, contentType });
      } else if (tag.localName === "Override") {
        const partName = tag.attributes.get("PartName");
        if (partName === undefined || contentType === undefined) {
          throw fault("invalid_content_types", "Override entry lacks PartName or ContentType");
        }
        const name = asPackageDamage("invalid_content_types", "Override entry has a malformed PartName", () =>
          normalizePartName(partName),
        );
        const key = partNameKey(name);
        if (!table.overrides.has(key)) table.overrides.set(key, { partName: name, contentType });
      }
    }
    return table;
  }

  /** Content type of a part: its Override, else the Default of its extension, else null. */
  typeOf(partName: PartName): string | null {
    const override = this.overrides.get(partNameKey(partName));
    if (override) return override.contentType;
    return this.defaultFor(partExtension(partName));
  }

  defaultFor(extension: string): string | null {
    if (extension === "") return null;
    return this.defaults.get(extension.toLowerCase())?.contentType ?? null;
  }

  /** Adds or replaces a Default. Returns true when the table changed. */
  setDefault(extension: string, contentType: string): boolean {
    const key = normalizeExtension(extension);
    const value = requireContentType(contentType);
    if (this.defaults.get(key)?.contentType === value) return false;
    this.defaults.set(key, { extension: key, contentType: value });
    return true;
  }

  /**
   * Makes `partName` resolve to `contentType`, using the Default of its
   * extension when that already gives the type and an Override otherwise.
   * Returns true when the table changed.
   */
  assign(partName: PartName, contentType: string): boolean {
    const name = normalizePartName(partName);
    const value = requireContentType(contentType);
    if (this.typeOf(name) === value) return false;
    const key = partNameKey(name);
    if (this.defaultFor(partExtension(name)) === value) {
      this.overrides.delete(key);
    } else {
      this.overrides.set(key, { partName: name, contentType: value });
    }
    return true;
  }

  /** Returns true when an Override was removed. */
  removeOverride(partName: PartName): boolean {
    return this.overrides.delete(partNameKey(partName));
  }

  /** A detached copy in written order. */
  snapshot(): ContentTypes {
    return {
      defaults: [...this.defaults.values()].map((entry) => ({ ...entry })),
      overrides: [...this.overrides.values()].map((entry) => ({ ...entry })),
    };
  }

  serialize(): Uint8Array {
    let xml = `${XML_DECLARATION}<Types xmlns="${CONTENT_TYPES_NAMESPACE}">`;
    for (const entry of this.defaults.values()) {
      xml += `<Default Extension="${escapeXmlAttribute(entry.extension)}" ContentType="${escapeXmlAttribute(entry.contentType)}"/>`;
    }
    for (const entry of this.overrides.values()) {
      xml += `<Override PartName="${escapeXmlAttribute(entry.partName)}" ContentType="${escapeXmlAttribute(entry.contentType)}"/>`;
    }
    return encodeUtf8(`${xml}</Types>`);
  }
}
