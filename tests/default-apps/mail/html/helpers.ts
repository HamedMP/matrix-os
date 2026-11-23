import { expect } from "vitest";

/** Elements that must never survive sanitising, whatever the input was. */
export const FORBIDDEN_SELECTOR = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button",
  "select", "option", "textarea", "meta", "base", "link", "svg", "math", "template", "noscript", "video",
  "audio", "source", "foreignObject", "title", "xmp", "plaintext", "isindex", "area", "map", "canvas", "dialog",
].join(",");

const SAFE_HREF = /^(https?:\/\/|mailto:)/;
const SAFE_SRC = /^(https?:\/\/|data:image\/(png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+=*$)/;
const DANGEROUS_ATTRIBUTE_TEXT = /javascript:|vbscript:|data:text|expression\s*\(|url\s*\(|@import|-moz-binding|behavior\s*:|position\s*:\s*fixed/i;

export function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html").body;
}

/**
 * Asserts that markup is inert when a browser parses it: no active elements,
 * no event handlers, no unsafe URL, no dangerous CSS, and that parsing it
 * again does not change it (no mutation on re-parse).
 */
export function expectInert(html: string): HTMLElement {
  const body = parseBody(html);
  expect(body.querySelectorAll(FORBIDDEN_SELECTOR).length, `forbidden element in: ${html}`).toBe(0);
  for (const element of Array.from(body.querySelectorAll("*"))) {
    expect(element.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      expect(name.startsWith("on"), `event handler ${name} in: ${html}`).toBe(false);
      expect(["id", "name", "srcset", "srcdoc", "action", "formaction", "background", "xlink:href", "ping"]).not.toContain(name);
      if (name === "href") expect(attribute.value, `href in: ${html}`).toMatch(SAFE_HREF);
      else if (name === "src") expect(attribute.value, `src in: ${html}`).toMatch(SAFE_SRC);
      else if (name !== "title" && name !== "alt" && name !== "aria-label") {
        expect(DANGEROUS_ATTRIBUTE_TEXT.test(attribute.value), `dangerous ${name}="${attribute.value}"`).toBe(false);
      }
    }
  }
  for (const link of Array.from(body.querySelectorAll("a[href]"))) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
  expect(body.innerHTML, "markup changes when parsed again").toBe(html);
  return body;
}

/** A 1x1 transparent PNG. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
