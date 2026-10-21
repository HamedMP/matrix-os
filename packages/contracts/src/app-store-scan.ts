import type { AppStoreScanFinding, AppStoreScanReport } from "./app-store.js";

/**
 * Deterministic App Store scanner (spec 631 FR-003). Pure: callers pass decoded files.
 * Findings never contain matched text; only rule, location and a fixed message.
 */

export const REDACTED_SECRET = "__MATRIX_REDACTED_SECRET__";
const MAX_FINDINGS = 500;
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "html", "htm", "css", "scss", "md", "mdx",
  "yaml", "yml", "txt", "svg", "toml", "xml", "csv",
]);
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"]);

type Category = AppStoreScanFinding["category"];
type Severity = AppStoreScanFinding["severity"];
interface LineRule { rule: string; category: Category; severity: Severity; message: string; pattern: RegExp }

const SECRET_RULES: LineRule[] = [
  { rule: "secret.url_credentials", pattern: /https?:\/\/[^\s/"']+:[^\s/@"']+@/g, message: "Credential-bearing URL" },
  { rule: "secret.anthropic", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, message: "Anthropic API key" },
  { rule: "secret.openai", pattern: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g, message: "OpenAI-style API key" },
  { rule: "secret.aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g, message: "AWS access key" },
  { rule: "secret.github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g, message: "GitHub token" },
  { rule: "secret.stripe", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, message: "Stripe key" },
  { rule: "secret.slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, message: "Slack token" },
  { rule: "secret.google", pattern: /\bAIza[0-9A-Za-z_-]{35}/g, message: "Google API key" },
  { rule: "secret.private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, message: "Private key" },
  { rule: "secret.jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, message: "Signed token" },
].map(rule => ({ ...rule, category: "secret" as const, severity: "high" as const }));

const GENERIC_SECRET = /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token|password|passwd)["']?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/gi;

const OTHER_RULES: LineRule[] = [
  { rule: "owner_config.home_path", category: "owner_config", severity: "high", message: "Absolute path from the owner's computer",
    pattern: /(?:\/home\/[a-z_][a-z0-9_-]*\/|\/Users\/[A-Za-z0-9._-]+\/|\/root\/|~\/(?:apps|system|data|projects|agents)\/)/g },
  { rule: "owner_config.analytics_id", category: "owner_config", severity: "medium", message: "Analytics or tracking ID",
    pattern: /\b(?:G-[A-Z0-9]{8,12}|UA-\d{4,10}-\d{1,4}|phc_[A-Za-z0-9]{20,})\b/g },
  { rule: "personal.phone", category: "personal", severity: "medium", message: "Phone number",
    pattern: /(?<![\d.])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?!\d)/g },
  { rule: "unsafe_code.storage", category: "unsafe_code", severity: "medium", message: "Browser storage is unavailable to store apps; use the Matrix database",
    pattern: /\b(?:localStorage|sessionStorage)\b/g },
  { rule: "unsafe_code.eval", category: "unsafe_code", severity: "high", message: "Dynamic code execution",
    pattern: /(?<![.\w$])eval\s*\(|\bnew\s+Function\s*\(/g },
  { rule: "unsafe_code.raw_api", category: "unsafe_code", severity: "high", message: "Direct Matrix API call; use the MatrixOS bridge",
    pattern: /["'`]\/api\//g },
  { rule: "unsafe_code.gateway_fetch", category: "unsafe_code", severity: "medium", message: "gatewayFetch is unavailable to store apps",
    pattern: /\bgatewayFetch\s*\(/g },
  { rule: "unsafe_code.parent_frame", category: "unsafe_code", severity: "high", message: "Access to the host window",
    pattern: /\bwindow\.(?:parent|top|opener)\b|\b(?:parent|top)\.postMessage\b|\btop\.location\b/g },
  { rule: "unsafe_code.cookie", category: "unsafe_code", severity: "high", message: "Cookie access", pattern: /\bdocument\.cookie\b/g },
  { rule: "unsafe_code.import_scripts", category: "unsafe_code", severity: "high", message: "Remote script import", pattern: /\bimportScripts\s*\(/g },
  { rule: "unsafe_code.websocket", category: "unsafe_code", severity: "medium", message: "External WebSocket connection",
    pattern: /new\s+WebSocket\s*\(\s*["'`]wss?:\/\//g },
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,24})\b/g;
const IGNORED_EMAIL_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
const IMAGE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico"]);
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]([^"'`\n]+)["'`]/g;

function isText(path: string, data: Buffer): boolean {
  const name = path.split("/").pop() ?? path;
  if (LOCKFILES.has(name)) return !data.subarray(0, 8192).includes(0);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  return !data.subarray(0, 8192).includes(0);
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksSecret(value: string): boolean {
  if (/your|example|placeholder|changeme|xxxx|redacted|dummy|sample/i.test(value)) return false;
  if (/^[A-Z0-9_]+$/.test(value) || value.includes("${")) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter(re => re.test(value)).length;
  return classes >= 2 && entropy(value) >= 3.5;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvesOutside(file: string, specifier: string): boolean {
  if (specifier.startsWith("/")) return true;
  if (!specifier.startsWith(".")) return false;
  const parts = file.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return true;
      parts.pop();
    } else parts.push(segment);
  }
  return false;
}

/** Index of the closing paren for `service(` and the top-level arguments, or null when unbalanced. */
function serviceArguments(source: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let i = open + 1; i < source.length && i < open + 600; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" && depth === 0) { args.push(source.slice(start, i).trim()); return args; }
    else if (char === ")" || char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) { args.push(source.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

export interface ScanOptions { ownerTerms?: readonly string[] }

export function scanAppFiles(files: ReadonlyMap<string, Buffer>, options: ScanOptions = {}): AppStoreScanReport {
  const findings: AppStoreScanFinding[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const ownerTerms = (options.ownerTerms ?? []).map(t => t.trim()).filter(t => t.length >= 3);
  const ownerPatterns = ownerTerms.map(t => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(t)}(?![A-Za-z0-9])`, "gi"));
  const ownerLower = new Set(ownerTerms.map(t => t.toLowerCase()));

  const add = (rule: string, category: Category, severity: Severity, file: string, line: number, message: string) => {
    const key = `${rule}\u0000${file}\u0000${line}`;
    if (seen.has(key)) return;
    if (findings.length >= MAX_FINDINGS) { truncated = true; return; }
    seen.add(key);
    findings.push({ rule, category, severity, file: redactSecrets(file).text, line, message });
  };

  for (const path of [...files.keys()].sort()) {
    if (truncated) break;
    const data = files.get(path)!;
    const codeText = isText(path, data) && !LOCKFILES.has(path.split("/").pop() ?? "");
    for (const pattern of ownerPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(path)) add("personal.owner_path", "personal", "high", path, 1, "Owner identity in file name");
    }
    for (const rule of SECRET_RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(path)) add(rule.rule, "secret", "high", path, 1, "Credential in file name");
    }
    const source = data.toString("utf8");
    const lines = source.split("\n");
    for (const [index, text] of lines.entries()) {
      if (truncated) break;
      const line = index + 1;
      for (const rule of (codeText ? [...SECRET_RULES, ...OTHER_RULES] : SECRET_RULES)) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(text)) add(rule.rule, rule.category, rule.severity, path, line, rule.message);
      }
      GENERIC_SECRET.lastIndex = 0;
      for (const match of text.matchAll(GENERIC_SECRET)) {
        if (looksSecret(match[1])) add("secret.generic", "secret", "high", path, line, "Hardcoded credential");
      }
      for (const pattern of ownerPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) add("personal.owner", "personal", "high", path, line, "Owner name, handle or email");
      }
      if (!codeText) continue;
      for (const match of text.matchAll(EMAIL)) {
        const email = match[0];
        if (IMAGE_TLDS.has(match[1].toLowerCase()) || IGNORED_EMAIL_DOMAIN.test(email) || ownerLower.has(email.toLowerCase())) continue;
        add("personal.email", "personal", "medium", path, line, "Email address");
      }
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        if (resolvesOutside(path, match[1])) add("unsafe_code.outside_import", "unsafe_code", "high", path, line, "Import outside the app folder");
      }
    }
    if (!codeText || truncated) continue;
    let serviceLine = 1;
    let serviceOffset = 0;
    for (const match of source.matchAll(/\bservice\s*\(/g)) {
      if (truncated) break;
      while (serviceOffset < match.index!) {
        if (source.charCodeAt(serviceOffset++) === 10) serviceLine++;
      }
      const args = serviceArguments(source, match.index! + match[0].length - 1);
      if (args && args.length === 4 && /^["'`]/.test(args[3])) {
        add("owner_config.account_label", "owner_config", "medium", path, serviceLine, "Fixed integration account");
      }
    }
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
  return { findings, truncated, blocking: truncated || findings.some(f => f.severity === "high") };
}

/** Replace high-severity secret values before any file is shown to an AI provider. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  // Remove entire PEM blocks, including escaped newlines in source literals.
  let output = text.replace(/-----BEGIN ((?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, () => { count++; return REDACTED_SECRET; });
  for (const rule of SECRET_RULES) {
    output = output.replace(new RegExp(rule.pattern.source, "g"), () => { count++; return REDACTED_SECRET; });
  }
  output = output.replace(new RegExp(GENERIC_SECRET.source, "gi"), (whole: string, value: string) => {
    if (!looksSecret(value)) return whole;
    count++;
    return whole.replace(value, REDACTED_SECRET);
  });
  return { text: output, count };
}
