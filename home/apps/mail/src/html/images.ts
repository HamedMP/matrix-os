/** Image helpers for the sanitiser: tracking-pixel detection and the placeholders that stand in for images. */
import { cleanLabel } from "./dom";

export const BLOCKED_IMAGE_CLASS = "mx-image-blocked";
export const MISSING_IMAGE_CLASS = "mx-image-missing";

const MAX_PLACEHOLDER_SIDE = 2000;

function attributeLength(value: string | null): number | null {
  const match = /^\s*(\d{1,6}(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value ?? "");
  return match ? Number(match[1]) : null;
}

function styleLength(style: string, property: "width" | "height"): number | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(\\d{1,6}(?:\\.\\d+)?)\\s*(?:px)?\\s*(?:!\\s*important\\s*)?(?:;|$)`, "i").exec(style);
  return match ? Number(match[1]) : null;
}

interface ImageBox {
  width: number | null;
  height: number | null;
  hidden: boolean;
}

function imageBox(image: Element): ImageBox {
  const style = image.getAttribute("style") ?? "";
  return {
    width: styleLength(style, "width") ?? attributeLength(image.getAttribute("width")),
    height: styleLength(style, "height") ?? attributeLength(image.getAttribute("height")),
    hidden: /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style) || image.hasAttribute("hidden"),
  };
}

/**
 * True for a remote image that exists to report that the mail was opened: one
 * that is hidden, has no size, or is at most one pixel in both directions.
 */
export function isTrackingPixel(image: Element): boolean {
  const { width, height, hidden } = imageBox(image);
  return hidden || width === 0 || height === 0 || (width !== null && height !== null && width <= 1 && height <= 1);
}

function placeholder(doc: Document, image: Element, className: string, prefix: string): HTMLElement {
  const alt = cleanLabel(image.getAttribute("alt"), 200);
  const { width, height } = imageBox(image);
  const span = doc.createElement("span");
  span.setAttribute("class", className);
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", alt ? `${prefix}: ${alt}` : prefix);
  const size = [
    width && width > 1 ? `width:${Math.min(Math.round(width), MAX_PLACEHOLDER_SIDE)}px` : "",
    height && height > 1 ? `height:${Math.min(Math.round(height), MAX_PLACEHOLDER_SIDE)}px` : "",
  ].filter(Boolean);
  if (size.length > 0) span.setAttribute("style", size.join(";"));
  if (alt) span.appendChild(doc.createTextNode(alt));
  return span;
}

/** Stands in for a remote image that was not loaded. Keeps the image's size so the layout holds. */
export function blockedImagePlaceholder(doc: Document, image: Element): HTMLElement {
  return placeholder(doc, image, BLOCKED_IMAGE_CLASS, "Blocked image");
}

/** Stands in for an inline image that is not available or was refused. */
export function missingImagePlaceholder(doc: Document, image: Element): HTMLElement {
  return placeholder(doc, image, MISSING_IMAGE_CLASS, "Missing image");
}
