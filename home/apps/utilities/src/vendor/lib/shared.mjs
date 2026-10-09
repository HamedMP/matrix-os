export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function validUrl(value, { httpsOnly = false } = {}) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid absolute URL."); }
  if ((httpsOnly && url.protocol !== "https:") || !["https:", "http:"].includes(url.protocol)) {
    throw new Error(httpsOnly ? "Enter an HTTPS URL." : "Enter an HTTP or HTTPS URL.");
  }
  if (url.username || url.password) throw new Error("URLs with credentials are not supported.");
  return url;
}

export function splitParts(input, count) {
  const parts = input.split("|").map((part) => part.trim());
  if (parts.length !== count || parts.some((part) => !part)) throw new Error(`Enter ${count} non-empty values separated by |.`);
  return parts;
}

export function decodeEntities(input) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return input.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (all, entity) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : all;
    }
    return named[entity.toLowerCase()] ?? all;
  });
}
