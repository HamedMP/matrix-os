/** Number format presets and the decimal buttons of the toolbar. */

export interface NumberFormatPreset {
  id: "general" | "number" | "currency" | "percent" | "date";
  label: string;
  code: string;
}

export const NUMBER_FORMAT_PRESETS: readonly NumberFormatPreset[] = [
  { id: "general", label: "General", code: "General" },
  { id: "number", label: "Number", code: "#,##0.00" },
  { id: "currency", label: "Currency", code: "$#,##0.00" },
  { id: "percent", label: "Percent", code: "0.00%" },
  { id: "date", label: "Date", code: "yyyy-mm-dd" },
];

/** The preset a format code belongs to, ignoring its number of decimals; null for anything else. */
export function presetOf(code: string): NumberFormatPreset["id"] | null {
  const trimmed = code.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "general") return "general";
  const outside = unquoted(trimmed);
  if (/[ymdhs]/i.test(outside) && !/[0#?]/.test(outside)) return "date";
  if (outside.includes("%")) return "percent";
  if (outside.includes("$")) return "currency";
  if (/^#,##0(\.0+)?$/.test(trimmed)) return "number";
  return null;
}

/** The code with quoted text, bracketed parts and escaped characters taken out. */
function unquoted(code: string): string {
  return code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
}

/** Splits a format code into its `;` sections, leaving `;` inside quotes alone. */
function sections(code: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "\\" && !quoted) {
      current += ch + code.charAt(i + 1);
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Changes the decimals of the first number in one section. */
function shiftSection(section: string, delta: number): string {
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < section.length; i++) {
    const ch = section.charAt(i);
    if (ch === "\\" && !quoted) {
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") bracket = true;
    else if (!quoted && ch === "]") bracket = false;
    if (quoted || bracket || !/[0#?]/.test(ch)) continue;
    let end = i;
    while (end < section.length && /[0#?,]/.test(section.charAt(end))) end++;
    let decimals = 0;
    let after = end;
    if (section.charAt(end) === ".") {
      after = end + 1;
      while (after < section.length && /[0#?]/.test(section.charAt(after))) after++;
      decimals = after - end - 1;
    }
    const next = Math.max(0, Math.min(15, decimals + delta));
    return section.slice(0, end) + (next > 0 ? `.${"0".repeat(next)}` : "") + section.slice(after);
  }
  return section;
}

/** One decimal more (`delta` 1) or fewer (-1). Dates and text formats stay as they are. */
export function changeDecimals(code: string, delta: 1 | -1): string {
  const trimmed = code.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "general") return delta > 0 ? "0.0" : "0";
  if (presetOf(trimmed) === "date" || trimmed === "@") return code;
  return sections(code).map((section) => shiftSection(section, delta)).join(";");
}
