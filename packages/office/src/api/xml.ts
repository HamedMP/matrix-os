/**
 * Contract: lossless XML tree. Implemented by `src/xml/index.ts`.
 *
 * Type-only. Each function type is implemented as a value export with the
 * camelCase name given in {@link XmlModule}.
 *
 * Round-trip rule: `serializeXml(parseXml(text)) === text` for every
 * well-formed input, character for character. To make that possible the
 * parser keeps what an XML processor normally discards (quote style, entity
 * spelling, whitespace inside tags, line endings) in the `raw`, `lead`,
 * `eq`, `quote`, `openTagTail`, `closeTagTail` and `selfClosing` fields.
 *
 * Mutation rule: every field is `readonly`. Change a tree only through the
 * helper functions of this module; they keep `parent` links and the raw
 * fields consistent. A node edited through a helper is serialised from its
 * decoded value with standard escaping; untouched nodes keep their source text.
 *
 * Security: no DTD and no entity expansion. A `<!DOCTYPE` declaration, or a
 * reference to any entity other than `&lt; &gt; &amp; &quot; &apos;` and
 * numeric character references, throws `OfficeError("malformed_xml")`.
 * Depth and node count are bounded by {@link XmlParseLimits} (`limit_exceeded`).
 *
 * Names are qualified names exactly as written (`w:p`, `xmlns:w`, `sheetData`).
 * Line endings and attribute whitespace are not normalised.
 */

export type XmlNode =
  | XmlElement
  | XmlText
  | XmlCData
  | XmlComment
  | XmlProcessingInstruction
  | XmlDeclaration;

/** A node that can be a child of an element. */
export type XmlChildNode = XmlElement | XmlText | XmlCData | XmlComment | XmlProcessingInstruction;

export interface XmlDocument {
  readonly kind: "document";
  /**
   * Everything at the top level in source order: the optional declaration,
   * comments, processing instructions, whitespace text and exactly one element.
   */
  readonly children: readonly XmlNode[];
  /** The single top-level element; also present in `children`. */
  readonly root: XmlElement;
  /** True when the source began with U+FEFF; the serialiser writes it back. */
  readonly bom: boolean;
}

export interface XmlAttr {
  /** Qualified name as written, for example `w:val` or `xmlns:w`. */
  readonly name: string;
  /** Decoded value: character and predefined entity references replaced. */
  readonly value: string;
  /** Source text between the quotes, or null when the value was set through a helper. */
  readonly raw: string | null;
  readonly quote: '"' | "'";
  /** Whitespace before the name. `" "` for attributes added through a helper. */
  readonly lead: string;
  /** Text between the name and the opening quote: `=` with any surrounding whitespace. */
  readonly eq: string;
}

export interface XmlElement {
  readonly kind: "element";
  /** Qualified name as written, for example `w:p`. */
  readonly name: string;
  /** Attributes in source order, namespace declarations included. */
  readonly attrs: readonly XmlAttr[];
  readonly children: readonly XmlChildNode[];
  /** Null for a detached element. */
  readonly parent: XmlElement | XmlDocument | null;
  /** With no children: true writes `<a/>`, false writes `<a></a>`. Ignored otherwise. */
  readonly selfClosing: boolean;
  /** Whitespace between the last attribute (or the name) and `>` or `/>`. */
  readonly openTagTail: string;
  /** Whitespace between the name and `>` in the end tag. */
  readonly closeTagTail: string;
}

/**
 * Character data. Whitespace between elements is an ordinary text node, also
 * at the top level of the document; see {@link IsWhitespaceText}.
 */
export interface XmlText {
  readonly kind: "text";
  /** Decoded text. */
  readonly value: string;
  /** Source text with its entity references, or null when set through a helper. */
  readonly raw: string | null;
  readonly parent: XmlElement | XmlDocument | null;
}

export interface XmlCData {
  readonly kind: "cdata";
  /** Content between `<![CDATA[` and `]]>`, verbatim. */
  readonly value: string;
  readonly parent: XmlElement | null;
}

export interface XmlComment {
  readonly kind: "comment";
  /** Content between `<!--` and `-->`, verbatim. */
  readonly value: string;
  readonly parent: XmlElement | XmlDocument | null;
}

export interface XmlProcessingInstruction {
  readonly kind: "pi";
  readonly target: string;
  /** Everything between the target and `?>`, verbatim, leading whitespace included. */
  readonly data: string;
  readonly parent: XmlElement | XmlDocument | null;
}

/** The `<?xml … ?>` declaration. Only valid as the first node of a document. */
export interface XmlDeclaration {
  readonly kind: "declaration";
  /** The whole declaration from `<?xml` to `?>`, verbatim. */
  readonly raw: string;
  readonly version: string;
  readonly encoding: string | null;
  readonly standalone: "yes" | "no" | null;
  readonly parent: XmlDocument | null;
}

export interface XmlParseLimits {
  /** Maximum element nesting depth. Default 512. */
  maxDepth: number;
  /** Maximum number of nodes of all kinds. Default 2 000 000. */
  maxNodes: number;
}

/** Attributes for a new element: in the given order. */
export type XmlAttrInit = Readonly<Record<string, string>> | ReadonlyArray<readonly [name: string, value: string]>;

/**
 * Parses a document. A leading U+FEFF is recorded in `bom`.
 * Throws `malformed_xml` (details: `offset`) or `limit_exceeded`.
 */
export type ParseXml = (text: string, limits?: Partial<XmlParseLimits>) => XmlDocument;

/**
 * Serialises a document, or one element with its subtree.
 *
 * Nodes without `raw` are escaped: in text `&`, `<` and `>`; in attribute
 * values `&`, `<`, the quote character and tab, line feed and carriage return
 * (as `&#9;`, `&#10;`, `&#13;`).
 */
export type SerializeXml = (node: XmlDocument | XmlElement) => string;

/** First child element with the qualified name, or null. */
export type Child = (parent: XmlElement, name: string) => XmlElement | null;
/** Child elements in order; all of them, or those with the qualified name. */
export type Children = (parent: XmlElement, name?: string) => XmlElement[];
/** First descendant element with the qualified name in document order; the start element is not a candidate. */
export type Find = (start: XmlElement | XmlDocument, name: string) => XmlElement | null;
/** All descendant elements with the qualified name in document order. */
export type FindAll = (start: XmlElement | XmlDocument, name: string) => XmlElement[];

/** Decoded attribute value, or null when the attribute is absent. */
export type GetAttr = (element: XmlElement, name: string) => string | null;
/** Sets an attribute in place, or appends it. Clears the attribute's `raw`. */
export type SetAttr = (element: XmlElement, name: string, value: string) => void;
/** Returns false when the attribute was absent. */
export type RemoveAttr = (element: XmlElement, name: string) => boolean;

/**
 * Creates a detached element. String children become text nodes. With no
 * children the element is self-closing.
 */
export type CreateElement = (
  name: string,
  attrs?: XmlAttrInit,
  children?: ReadonlyArray<XmlChildNode | string>,
) => XmlElement;
/** Creates a detached text node. */
export type CreateText = (value: string) => XmlText;

/**
 * Tree edits. A node that already has a parent is moved (removed from its old
 * parent first). Inserting a node into its own subtree, or next to a
 * reference node that has no element parent, throws `invalid_operation`.
 */
export type AppendChild = (parent: XmlElement, node: XmlChildNode) => void;
export type PrependChild = (parent: XmlElement, node: XmlChildNode) => void;
export type InsertBefore = (reference: XmlChildNode, node: XmlChildNode) => void;
export type InsertAfter = (reference: XmlChildNode, node: XmlChildNode) => void;
/** Detaches a node from its parent. A detached node is left as it is. */
export type Remove = (node: XmlChildNode) => void;
/** Puts `replacement` where `node` was and detaches `node`. */
export type ReplaceNode = (node: XmlChildNode, replacement: XmlChildNode) => void;
/** Deep copy, detached, keeping every raw field so that it serialises identically. */
export type CloneNode = <T extends XmlChildNode>(node: T) => T;
/** Deep copy of a whole document; it serialises identically to the original. */
export type CloneDocument = (document: XmlDocument) => XmlDocument;

/** Concatenated decoded value of all text and CDATA descendants, in document order. */
export type TextContent = (node: XmlElement | XmlText | XmlCData) => string;
/** Replaces all children with one text node (or none for an empty string). */
export type SetTextContent = (element: XmlElement, text: string) => void;
/** Changes the value of a text node and clears its `raw`. */
export type SetText = (node: XmlText, value: string) => void;
/** True for a text node made only of space, tab, line feed and carriage return. */
export type IsWhitespaceText = (node: XmlNode) => node is XmlText;

/** `w:p` gives `p`; `sheetData` gives `sheetData`. */
export type LocalName = (qualifiedName: string) => string;
/** `w:p` gives `w`; `sheetData` gives the empty string. */
export type PrefixOf = (qualifiedName: string) => string;
/**
 * Namespace URI bound to a prefix at this element (`""` for the default
 * namespace), found on the element or its ancestors. Null when unbound.
 */
export type LookupNamespace = (element: XmlElement, prefix: string) => string | null;

/** Escapes `&`, `<`, `>` and the carriage return (`&#13;`: a reader turns a literal one into a line feed). */
export type EscapeXmlText = (value: string) => string;
/** Escapes for a double-quoted attribute value, as described on {@link SerializeXml}. */
export type EscapeXmlAttr = (value: string) => string;

/** The value exports of `src/xml/index.ts`. */
export interface XmlModule {
  parseXml: ParseXml;
  serializeXml: SerializeXml;
  child: Child;
  children: Children;
  find: Find;
  findAll: FindAll;
  getAttr: GetAttr;
  setAttr: SetAttr;
  removeAttr: RemoveAttr;
  createElement: CreateElement;
  createText: CreateText;
  appendChild: AppendChild;
  prependChild: PrependChild;
  insertBefore: InsertBefore;
  insertAfter: InsertAfter;
  remove: Remove;
  replaceNode: ReplaceNode;
  cloneNode: CloneNode;
  cloneDocument: CloneDocument;
  textContent: TextContent;
  setTextContent: SetTextContent;
  setText: SetText;
  isWhitespaceText: IsWhitespaceText;
  localName: LocalName;
  prefixOf: PrefixOf;
  lookupNamespace: LookupNamespace;
  escapeXmlText: EscapeXmlText;
  escapeXmlAttr: EscapeXmlAttr;
  /** `{ maxDepth: 512, maxNodes: 2_000_000 }`, frozen. */
  DEFAULT_XML_LIMITS: Readonly<XmlParseLimits>;
}
