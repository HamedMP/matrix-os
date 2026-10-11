import { escapeHtml, decodeEntities } from "./shared.mjs";

function parseJson(input) {
  try { return JSON.parse(input); } catch (error) { reportToolFailure(error); throw new Error("Enter valid JSON."); }
}

function csvRows(input) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted cell.");
  row.push(cell); rows.push(row);
  if (rows.at(-1)?.length === 1 && rows.at(-1)[0] === "" && rows.length > 1) rows.pop();
  if (rows.length > 1001 || rows.some((item) => item.length > 100)) throw new Error("CSV is limited to 1,000 rows and 100 columns.");
  return rows;
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function regexResult(input) {
  const end = input.indexOf("\n");
  if (end < 1) throw new Error("Put a pattern on the first line and text below it.");
  const pattern = input.slice(0, end), sample = input.slice(end + 1);
  if (pattern.length > 200 || sample.length > 10_000) throw new Error("Regex input is too large.");
  // Potentially costly patterns never run on the UI thread. Browser workers have a hard deadline.
  if (typeof Worker !== "undefined" && typeof Blob !== "undefined") {
    const source = `const toolFailureDiagnostic=${toolFailureDiagnostic.toString()};const reportToolFailure=(cause)=>{try{console.warn("Utility operation failed.",toolFailureDiagnostic(cause))}catch(loggingFailure){toolFailureDiagnostic(loggingFailure)}};onmessage=({data})=>{try{const r=new RegExp(data.pattern,"g");const hits=[];for(const m of data.sample.matchAll(r)){hits.push(m[0]+" @ "+m.index);if(hits.length>=100)break}postMessage({hits})}catch(error){reportToolFailure(error);postMessage({error:"Enter a valid regular expression."})}}`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      return await new Promise((resolve, reject) => {
        const worker = new Worker(url);
        const timer = setTimeout(() => { worker.terminate(); reject(new Error("Pattern took too long to run.")); }, 300);
        worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.hits.length ? data.hits.join("\n") : "No matches."); };
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error("Could not test pattern.")); };
        worker.postMessage({ pattern, sample });
      });
    } finally { URL.revokeObjectURL(url); }
  }
  if (typeof window !== "undefined") throw new Error("This browser does not support an isolated regex worker.");
  if (/[+*}][^\n]{0,12}[+*{]/.test(pattern)) throw new Error("Potentially costly pattern is not supported here.");
  let regex;
  try { regex = new RegExp(pattern, "g"); } catch (error) { reportToolFailure(error); throw new Error("Enter a valid regular expression."); }
  const hits = [...sample.matchAll(regex)].slice(0, 100).map((match) => `${match[0]} @ ${match.index}`);
  return hits.length ? hits.join("\n") : "No matches.";
}

export async function developerTool(slug, input) {
  switch (slug) {
    case "json-formatter": return JSON.stringify(parseJson(input), null, 2);
    case "json-validator": { const value = parseJson(input); return `Valid JSON\nRoot type: ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`; }
    case "json-minifier": return JSON.stringify(parseJson(input));
    case "json-to-csv": {
      const value = parseJson(input);
      if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Enter an array of 1 to 1,000 objects.");
      const keys = Object.keys(value[0]);
      if (!keys.length || keys.length > 100) throw new Error("Use 1 to 100 columns.");
      return [keys.map(csvCell).join(","), ...value.map((row) => keys.map((key) => csvCell(row[key])).join(","))].join("\n");
    }
    case "csv-to-json": {
      const [headers, ...rows] = csvRows(input);
      if (!headers?.length || headers.some((key) => !key.trim()) || new Set(headers).size !== headers.length) throw new Error("CSV needs unique, non-empty headers.");
      if (rows.some((row) => row.length !== headers.length)) throw new Error("Each CSV row must have the same number of columns as the header.");
      return JSON.stringify(rows.map((row) => Object.fromEntries(headers.map((key, i) => [key, row[i]]))), null, 2);
    }
    case "base64-encode": {
      const bytes = new TextEncoder().encode(input); let binary = "";
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      return btoa(binary);
    }
    case "base64-decode": {
      try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(input.trim()), (char) => char.charCodeAt(0))); }
      catch (error) { reportToolFailure(error); throw new Error("Enter valid Base64 encoded UTF-8 text."); }
    }
    case "url-encoder": return encodeURIComponent(input);
    case "url-decoder": { try { return decodeURIComponent(input); } catch (error) { reportToolFailure(error); throw new Error("Enter valid URL-encoded text."); } }
    case "html-encoder": return escapeHtml(input);
    case "html-decoder": return decodeEntities(input);
    case "hash-generator": {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    case "uuid-generator": {
      const count = Number(input.trim());
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Enter a count from 1 to 100.");
      return Array.from({ length: count }, () => crypto.randomUUID()).join("\n");
    }
    case "regex-tester": return regexResult(input);
    case "text-diff": {
      const parts = input.split(/^---\r?$/m);
      if (parts.length !== 2) throw new Error("Separate the two text blocks with --- on its own line.");
      // The separator consumes one adjacent line break on each side, not content whitespace.
      const left = parts[0].replace(/\r?\n$/, "").split(/\r?\n/), right = parts[1].replace(/^\r?\n/, "").split(/\r?\n/);
      if (left.length > 200 || right.length > 200) throw new Error("Diff is limited to 200 lines per side.");
      const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
      for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) matrix[i][j] = left[i] === right[j] ? 1 + matrix[i + 1][j + 1] : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      const result = []; let i = 0, j = 0;
      while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) { result.push(`  ${left[i]}`); i++; j++; }
        else if (j < right.length && (i === left.length || matrix[i][j + 1] >= matrix[i + 1][j])) result.push(`+ ${right[j++]}`);
        else result.push(`- ${left[i++]}`);
      }
      return result.join("\n");
    }
    case "timestamp-converter": {
      const raw = input.trim(); const number = Number(raw);
      const date = /^\d{10,13}$/.test(raw) ? new Date(number * (raw.length === 10 ? 1000 : 1)) : new Date(raw);
      if (Number.isNaN(date.getTime())) throw new Error("Enter a Unix timestamp or ISO date.");
      return `UTC: ${date.toISOString()}\nLocal: ${date.toLocaleString()}\nUnix seconds: ${Math.floor(date.getTime() / 1000)}`;
    }
    case "color-converter": {
      let hex = input.trim().replace(/^#/, "");
      if (/^[\da-f]{3}$/i.test(hex)) hex = [...hex].map((char) => char + char).join("");
      if (!/^[\da-f]{6}$/i.test(hex)) throw new Error("Enter a three- or six-digit hex color.");
      const [r, g, b] = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
      const channels = [r, g, b].map((value) => value / 255), max = Math.max(...channels), min = Math.min(...channels), delta = max - min;
      let h = 0, s = 0; const l = (max + min) / 2;
      if (delta) { s = delta / (1 - Math.abs(2 * l - 1)); h = max === channels[0] ? ((channels[1] - channels[2]) / delta) % 6 : max === channels[1] ? (channels[2] - channels[0]) / delta + 2 : (channels[0] - channels[1]) / delta + 4; h = (h * 60 + 360) % 360; }
      return `#${hex.toLowerCase()}\nRGB: rgb(${r}, ${g}, ${b})\nHSL: hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
    }
    default: throw new Error("Unknown developer tool.");
  }
}
import { reportToolFailure, toolFailureDiagnostic } from "./diagnostics.mjs";
