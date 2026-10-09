import { getTool } from "./catalog.mjs";
import { developerTool } from "./developer.mjs";
import { writingTool } from "./writing.mjs";
import { seoTool } from "./seo.mjs";
import { agentTool } from "./agents.mjs";
import { countText, replaceText, convertJsonCsv } from "./workspace-tools.mjs";

const MAX = 100_000;

function contrastRatio(hex, background) {
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const channels = [0, 2, 4].map((index) => parseInt(expanded.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const light = Math.max(luminance, background), dark = Math.min(luminance, background);
  return (light + 0.05) / (dark + 0.05);
}

function contrastReport(input) {
  const hex = input.trim().replace(/^#/, "");
  return [["white", 1], ["black", 0]].map(([name, luminance]) => {
    const ratio = contrastRatio(hex, luminance);
    return `Contrast with ${name}: ${ratio.toFixed(2)}:1 (AA normal text: ${ratio >= 4.5 ? "pass" : "fail"}; AA large text: ${ratio >= 3 ? "pass" : "fail"}; AAA normal text: ${ratio >= 7 ? "pass" : "fail"})`;
  }).join("\n");
}

function expandCronField(field, minimum, maximum, isWeekday = false) {
  const values = new Set();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let start, end;
    if (range === "*") { start = minimum; end = maximum; }
    else if (range.includes("-")) [start, end] = range.split("-").map(Number);
    else { start = Number(range); end = stepText === undefined ? start : maximum; }
    for (let value = start; value <= end; value += step) values.add(isWeekday && value === 7 ? 0 : value);
  }
  return values;
}

/** Five-field numeric cron, interpreted in UTC with standard day-of-month/weekday OR semantics. */
export function previewCron(input, now = new Date()) {
  agentTool("cron-expression-explainer", input);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("Enter a valid reference date.");
  const [minute, hour, day, month, weekday] = input.trim().split(/\s+/);
  const minutes = expandCronField(minute, 0, 59);
  const hours = expandCronField(hour, 0, 23);
  const days = expandCronField(day, 1, 31);
  const months = expandCronField(month, 1, 12);
  const weekdays = expandCronField(weekday, 0, 7, true);
  const dayWildcard = day.startsWith("*"), weekdayWildcard = weekday.startsWith("*");
  const results = [];
  const startDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let offset = 0; offset < 5 * 366 && results.length < 5; offset++) {
    const date = new Date(startDay + offset * 86_400_000);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const dayMatches = days.has(date.getUTCDate()), weekdayMatches = weekdays.has(date.getUTCDay());
    if (dayWildcard && !weekdayMatches || weekdayWildcard && !dayMatches || !dayWildcard && !weekdayWildcard && !dayMatches && !weekdayMatches) continue;
    for (let hourValue = 0; hourValue < 24 && results.length < 5; hourValue++) {
      if (!hours.has(hourValue)) continue;
      for (let minuteValue = 0; minuteValue < 60 && results.length < 5; minuteValue++) {
        if (!minutes.has(minuteValue)) continue;
        const instant = new Date(startDay + offset * 86_400_000 + hourValue * 3_600_000 + minuteValue * 60_000);
        if (instant > now) results.push(instant.toISOString());
      }
    }
  }
  if (results.length < 5) throw new Error("No run found within five years in UTC. Check the expression.");
  return results;
}

function convertCase(input) {
  const match = input.match(/^(upper|lower|title|sentence)\|([\s\S]+)$/);
  if (!match) throw new Error("Start with upper|, lower|, title|, or sentence|.");
  const [, mode, body] = match;
  if (mode === "upper") return body.toUpperCase();
  if (mode === "lower") return body.toLowerCase();
  const lower = body.toLowerCase();
  if (mode === "title") return lower.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_whole, prefix, letter) => prefix + letter.toUpperCase());
  let start = true;
  return [...lower].map((character) => {
    if (/[.!?]/u.test(character)) { start = true; return character; }
    if (start && /\p{L}/u.test(character)) { start = false; return character.toUpperCase(); }
    return character;
  }).join("");
}

function cleanText(input) {
  return input.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(/\u00a0/g, " ")
    .split("\n").map((line) => line.trim().replace(/[\t\f\v ]{2,}/g, " ").replace(/\t/g, " "))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function replaceLiteral(input) {
  const lines = input.split("\n");
  if (lines.length < 3 || !lines[0]) throw new Error("Enter search, replacement, and text on consecutive lines.");
  return lines.slice(2).join("\n").replaceAll(lines[0], () => lines[1]);
}

async function formatHash(input, format) {
  if (!["hex", "base64", "sri"].includes(format)) throw new Error("Choose a supported hash format.");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  if (format === "hex") return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoded = btoa(String.fromCharCode(...bytes));
  return format === "sri" ? `sha256-${encoded}` : encoded;
}

export async function runTool(slug, input, options = {}) {
  const tool = getTool(slug);
  if (!tool) throw new Error("Unknown tool.");
  if (typeof input !== "string" || input.length > MAX) throw new Error("Input must be a string of 100,000 characters or fewer.");
  if (!input.trim() && !["word-counter", "character-counter"].includes(slug)) throw new Error("Enter text to use this tool.");
  const runner = { Developer: developerTool, Writing: writingTool, SEO: seoTool, Agents: agentTool }[tool.category];
  let output;
  if (slug === "case-converter") output = convertCase(input);
  else if (slug === "text-cleaner") output = cleanText(input);
  else if (slug === "find-replace") output = Object.hasOwn(options, "search") ? replaceText(input, options.search, options.replacement ?? "") : replaceLiteral(input);
  else if (slug === "json-to-csv") output = convertJsonCsv(input, options);
  else if (slug === "word-counter" || slug === "character-counter") {
    const stats = countText(input);
    output = slug === "word-counter" ? `Words: ${stats.words}\nCharacters: ${stats.characters}\nSentences: ${stats.sentences}\nEstimated reading time: ${stats.readingMinutes} min` : `Characters: ${stats.characters}\nWithout whitespace: ${stats.withoutWhitespace}\nLines: ${stats.lines}\nUTF-8 bytes: ${stats.bytes}`;
  }
  else if (slug === "hash-generator") output = await formatHash(input, options.hashFormat ?? "hex");
  else if (slug === "cron-expression-explainer") {
    const explanation = agentTool(slug, input).replace(/\nCheck timezone and next runs in your scheduler\.$/, "");
    output = `${explanation}\n\nNext five runs (UTC):\n${previewCron(input).join("\n")}\nUTC may differ from your scheduler's timezone.`;
  } else {
    output = await runner(slug, input);
    if (slug === "color-converter") output += `\n${contrastReport(input)}`;
  }
  if (typeof output !== "string" || output.length > MAX) throw new Error("Result is too large to display.");
  return { output };
}
