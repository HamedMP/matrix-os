/**
 * Qualified names and namespace resolution.
 *
 * The tree stores names as written, so the same vocabulary can appear under
 * different prefixes in different files. These helpers resolve a prefix to
 * its namespace URI (and back) by reading the `xmlns` attributes in scope.
 */

import type { LocalName, LookupNamespace, PrefixOf, XmlAttr, XmlElement } from "../api/xml.js";

export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

export const localName: LocalName = (qualifiedName) => {
  const colon = qualifiedName.indexOf(":");
  return colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
};

export const prefixOf: PrefixOf = (qualifiedName) => {
  const colon = qualifiedName.indexOf(":");
  return colon === -1 ? "" : qualifiedName.slice(0, colon);
};

export const lookupNamespace: LookupNamespace = (element, prefix) => {
  if (prefix === "xml") return XML_NAMESPACE;
  if (prefix === "xmlns") return XMLNS_NAMESPACE;
  const declaration = prefix === "" ? "xmlns" : `xmlns:${prefix}`;
  let scope: XmlElement["parent"] = element;
  while (scope !== null && scope.kind === "element") {
    const attrs = scope.attrs;
    for (let index = 0; index < attrs.length; index++) {
      const attr = attrs[index] as XmlAttr;
      // An empty value removes the binding (`xmlns=""`).
      if (attr.name === declaration) return attr.value === "" ? null : attr.value;
    }
    scope = scope.parent;
  }
  return null;
};

/**
 * Namespace URI of the element's own name, or null when its prefix (or the
 * default namespace, for an unprefixed name) is not bound.
 */
export function namespaceOf(element: XmlElement): string | null {
  return lookupNamespace(element, prefixOf(element.name));
}

/**
 * A prefix bound to `uri` at this element: `""` when it is the default
 * namespace, null when no prefix in scope maps to it. A declaration that an
 * inner element has rebound to another URI is not returned.
 */
export function lookupPrefix(element: XmlElement, uri: string): string | null {
  if (uri === "") return null;
  if (uri === XML_NAMESPACE) return "xml";
  let scope: XmlElement["parent"] = element;
  while (scope !== null && scope.kind === "element") {
    const attrs = scope.attrs;
    for (let index = 0; index < attrs.length; index++) {
      const attr = attrs[index] as XmlAttr;
      if (attr.value !== uri) continue;
      let prefix: string;
      if (attr.name === "xmlns") prefix = "";
      else if (attr.name.startsWith("xmlns:")) prefix = attr.name.slice(6);
      else continue;
      if (lookupNamespace(element, prefix) === uri) return prefix;
    }
    scope = scope.parent;
  }
  return null;
}
