/**
 * Contract: ZIP container and OPC package. Implemented by `src/opc/index.ts`.
 *
 * Type-only. Each `export type Xxx = (...) => ...` function type is implemented
 * as a value export with the camelCase name given in {@link OpcModule}.
 *
 * Errors are {@link import("../errors.js").OfficeError}:
 * `not_a_zip`, `zip_limit_exceeded`, `corrupt_package`, `unsupported_format`,
 * `not_found`, `invalid_argument`, `invalid_operation`.
 */

/**
 * Bounds enforced while reading an untrusted archive (zip-bomb defence).
 * Sizes are uncompressed bytes. The declared sizes are checked when the
 * package is opened and the real sizes are enforced again while inflating,
 * so a lying header cannot exceed a bound.
 */
export interface ZipLimits {
  /** Maximum number of ZIP entries, directories included. Default 5000. */
  maxEntries: number;
  /** Maximum uncompressed size of one entry. Default 64 MiB. */
  maxEntryBytes: number;
  /** Maximum sum of the uncompressed sizes of all entries. Default 256 MiB. */
  maxTotalBytes: number;
}

/**
 * An OPC part name: absolute, forward slashes, for example `/word/document.xml`.
 *
 * Every method accepts a name with or without the leading slash and returns
 * the canonical form with it. Names are compared without regard to ASCII
 * case; the stored casing is kept. A name with an empty, `.` or `..` segment
 * or a backslash throws `invalid_argument`.
 */
export type PartName = string;

/** Source of a relationship set: a part name, or `"/"` for the package itself (`/_rels/.rels`). */
export type RelationshipSource = PartName | "/";

export interface PartInfo {
  name: PartName;
  /** Resolved from `[Content_Types].xml`: an Override wins over a Default. Null when neither matches. */
  contentType: string | null;
  /** Uncompressed size in bytes. */
  size: number;
  /** True for `/_rels/.rels` and every `…/_rels/*.rels` part. */
  isRelationships: boolean;
  /** True once the part was set, or its relationships were changed, since open. */
  modified: boolean;
}

export interface Relationship {
  /** For example `rId3`. Unique within one source. */
  id: string;
  /** Relationship type URI. */
  type: string;
  /** The target exactly as written: a URI relative to the source part, or an external URL. */
  target: string;
  targetMode: "Internal" | "External";
}

export interface NewRelationship {
  type: string;
  target: string;
  /** Default `"Internal"`. */
  targetMode?: "Internal" | "External";
  /** Omit to get the next free `rIdN`. A duplicate id throws `invalid_operation`. */
  id?: string;
}

export interface ContentTypeDefault {
  /** Lower-case extension without the dot, for example `xml`. */
  extension: string;
  contentType: string;
}

export interface ContentTypeOverride {
  partName: PartName;
  contentType: string;
}

export interface ContentTypes {
  defaults: ContentTypeDefault[];
  overrides: ContentTypeOverride[];
}

export interface ListPartsOptions {
  /** Include relationships parts. Default false. */
  includeRelationships?: boolean;
}

/**
 * An open OPC package.
 *
 * Losslessness rule: a part that was never passed to `setPart` or `removePart`
 * is written back by `save()` with its original stored bytes (the compressed
 * data, CRC, sizes, method and timestamp are reused; it is never inflated and
 * deflated again). The same holds for a relationships part whose
 * relationships were not changed and for `[Content_Types].xml` when no content
 * type was changed. `[Content_Types].xml` is written first and `/_rels/.rels`
 * second, as readers that stream the archive expect; the other entries keep
 * their original order and new parts are appended. An untouched entry keeps
 * its timestamp; a new or changed one gets the fixed stamp 1980-01-01, so
 * saving is deterministic. The archive as a whole need not be byte-identical
 * to the input.
 *
 * `[Content_Types].xml` and every relationships part are inflated and parsed
 * by `openPackage`, so content-type and relationship reads are synchronous.
 * Other parts are inflated on first read.
 */
export interface OpcPackage {
  /**
   * Parts in archive order, then added parts in insertion order.
   * `[Content_Types].xml` and directory entries are never listed.
   */
  listParts(options?: ListPartsOptions): PartInfo[];
  hasPart(name: PartName): boolean;
  /**
   * Uncompressed bytes of a part. The array may be shared with the package:
   * callers must not mutate it. Throws `not_found` for an unknown part.
   */
  getPartBytes(name: PartName): Promise<Uint8Array>;
  /**
   * The part decoded as text: UTF-8, or UTF-16 when a byte-order mark says so.
   * A byte-order mark is not part of the returned string.
   */
  getPartText(name: PartName): Promise<string>;
  /**
   * Creates or replaces a part. A string is encoded as UTF-8 without a
   * byte-order mark. `contentType` becomes an Override unless a Default for the
   * extension already gives that type. When it is omitted an existing part
   * keeps its type; a new part whose extension has no Default throws
   * `invalid_operation`. Setting `[Content_Types].xml` or a relationships
   * part directly throws `invalid_operation`.
   */
  setPart(name: PartName, data: Uint8Array | string, contentType?: string): void;
  /**
   * Removes a part, its content-type Override and its own relationships part.
   * Relationships that point at it from other parts are left for the caller.
   * Returns false when the part did not exist.
   */
  removePart(name: PartName): boolean;

  getContentType(name: PartName): string | null;
  getContentTypes(): ContentTypes;
  /** Adds or replaces the Default for an extension (given without the dot). */
  setDefaultContentType(extension: string, contentType: string): void;

  /** Relationships of a source in document order. Empty when it has none. */
  getRelationships(source: RelationshipSource): Relationship[];
  getRelationship(source: RelationshipSource, id: string): Relationship | null;
  getRelationshipsByType(source: RelationshipSource, type: string): Relationship[];
  /** Adds a relationship, creating the relationships part when needed. */
  addRelationship(source: RelationshipSource, relationship: NewRelationship): Relationship;
  /** Returns false when the id did not exist. */
  removeRelationship(source: RelationshipSource, id: string): boolean;
  /**
   * Resolves an internal relationship target against its source to a part
   * name, for example (`/word/document.xml`, `media/image1.png`) gives
   * `/word/media/image1.png`. Throws `invalid_argument` for a target that
   * leaves the package.
   */
  resolveTarget(source: RelationshipSource, target: string): PartName;

  /** Serialises the package to a ZIP archive. The package stays usable afterwards. */
  save(): Promise<Uint8Array>;
}

/**
 * Opens a package from the bytes of a `.docx`, `.xlsx` or any OPC file.
 *
 * - no ZIP structure: `not_a_zip`; an OLE compound file (an encrypted or
 *   legacy binary document): `unsupported_format`
 * - a limit exceeded: `zip_limit_exceeded`
 * - damaged archive, CRC mismatch, missing or malformed `[Content_Types].xml`
 *   or relationships part, duplicate or unsafe entry names: `corrupt_package`
 * - encrypted entries, multi-disk archives, ZIP64 archives, or a compression
 *   method other than stored (0) and deflate (8): `unsupported_format`
 * - an entry that inflates to more than its declared size: `corrupt_package`
 *   (a declared size over a limit is `zip_limit_exceeded` at open)
 *
 * `bytes` is not copied and must not be mutated while the package is in use.
 */
export type OpenPackage = (bytes: Uint8Array, limits?: Partial<ZipLimits>) => Promise<OpcPackage>;

/** Creates an empty package with Defaults for `rels` and `xml` and no parts. */
export type CreatePackage = () => OpcPackage;

/** The value exports of `src/opc/index.ts`. */
export interface OpcModule {
  openPackage: OpenPackage;
  createPackage: CreatePackage;
  /** `{ maxEntries: 5000, maxEntryBytes: 64 MiB, maxTotalBytes: 256 MiB }`, frozen. */
  DEFAULT_ZIP_LIMITS: Readonly<ZipLimits>;
}
