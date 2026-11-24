/**
 * Character references in untrusted HTML text and attribute values.
 * Numeric references are always decoded; named ones from a fixed table of
 * the names that occur in mail and documents. An unknown name stays as it
 * was written (and is escaped again on output).
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
  iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥", brvbar: "¦", sect: "§", uml: "¨", copy: "©",
  ordf: "ª", laquo: "«", not: "¬", shy: "\u00AD", reg: "®", macr: "¯", deg: "°", plusmn: "±", sup2: "²",
  sup3: "³", acute: "´", micro: "µ", para: "¶", middot: "·", cedil: "¸", sup1: "¹", ordm: "º", raquo: "»",
  frac14: "¼", frac12: "½", frac34: "¾", iquest: "¿", times: "×", divide: "÷",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ", szlig: "ß",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ", yuml: "ÿ",
  OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200C", zwj: "\u200D", lrm: "\u200E", rlm: "\u200F",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  dagger: "†", Dagger: "‡", bull: "•", hellip: "…", permil: "‰", prime: "′", Prime: "″",
  lsaquo: "‹", rsaquo: "›", oline: "‾", frasl: "⁄", euro: "€", trade: "™",
  larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔", rArr: "⇒", hArr: "⇔",
  minus: "−", lowast: "∗", radic: "√", infin: "∞", asymp: "≈", ne: "≠", equiv: "≡", le: "≤", ge: "≥",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", lambda: "λ", mu: "μ", pi: "π", sigma: "σ",
  omega: "ω", Delta: "Δ", Omega: "Ω", Sigma: "Σ", Pi: "Π",
};

const REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|([a-zA-Z][a-zA-Z0-9]{1,15}));?/g;

function fromCodePoint(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(code);
}

/** Decodes the character references in `text`. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (whole, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
    if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
    if (name !== undefined && whole.endsWith(";") && Object.hasOwn(NAMED, name)) return NAMED[name] as string;
    return whole;
  });
}
