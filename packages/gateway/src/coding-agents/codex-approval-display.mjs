import { posix } from "node:path";

const PRIVATE_CONTEXT = /\.ssh(?:\/|\b)|id_rsa|auth\.json|(?:^|\/)\.env(?:\b|\.)|[\w.-]+\.internal\b|-----BEGIN .*PRIVATE KEY|stack trace/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRET_KEY = "(?:[A-Za-z0-9_-]{0,128}(?:token|password|secret|credential|api[_-]?key)[A-Za-z0-9_-]{0,128}|authorization|cookie)";
const SECRET_VALUE = '(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s;,]+)';
const ASSIGNMENT = new RegExp(`(\\b${SECRET_KEY}["']?\\s*[=:]\\s*)${SECRET_VALUE}`, "gi");
const SECRET_FLAG = new RegExp(`(--${SECRET_KEY}(?:=|\\s+))${SECRET_VALUE}`, "gi");
const UNMASKED_SECRET = new RegExp(`\\b${SECRET_KEY}["']?\\s*(?:[=:]|\\s)\\s*(?!\\[redacted\\])[^\\s]`, "i");
const KNOWN_SECRET = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]+/g;
const HIDDEN = "Details withheld for privacy.";

/** Preview fields are display evidence only, never an executable/grant payload.
 * Read complete values before truncating so suffix credentials cannot leak.
 * @param {unknown} value @param {readonly string[]} roots */
function displayText(value, roots) {
  if (typeof value !== "string" || !value.trim()) return "Unavailable: not supplied by the agent.";
  if (value.length > 64 * 1024 || CONTROL.test(value) || PRIVATE_CONTEXT.test(value.replaceAll("\\", "/"))
    || /(?:^|[\s"'(=+])[A-Za-z]:[\\/]/.test(value)) return HIDDEN;
  let text = value.trim()
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, "[redacted authorization]")
    .replace(ASSIGNMENT, "$1[redacted]").replace(SECRET_FLAG, "$1[redacted]")
    .replace(KNOWN_SECRET, "[redacted]");
  // URL credentials and query values can be private even without a known key.
  text = text.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return "[redacted URL]";
      return url;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return "[redacted URL]";
    }
  });
  if (UNMASKED_SECRET.test(text.replaceAll("[redacted]", "MASKED"))) {
    // Known redactions are safe; inspect remaining text independently.
    const unmasked = text.replace(/[^\s]*[=:]\[redacted\]|--[^\s]+\s+\[redacted\]/g, "");
    if (UNMASKED_SECRET.test(unmasked)) return HIDDEN;
  }
  text = text.replace(/(^|[\s"'`(=:<>|;&])\/(?=[A-Za-z0-9._~-])(?!\/)[^\s"'`<>)]*/g,
    (match, prefix) => `${prefix}${displayPath(match.slice(prefix.length), roots) ?? "[redacted path]"}`);
  // Preserve the legacy display guard even for unusual token/path boundaries.
  if (/stack trace|\/(?:home|tmp|var)\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+/i.test(text)) return HIDDEN;
  return text;
}

/** @param {unknown} value @param {readonly string[]} roots */
function displayPath(value, roots) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096
    || CONTROL.test(value) || PRIVATE_CONTEXT.test(value) || /[\r\n\\]/.test(value)
    || /token|secret|password|credential/i.test(value)) return undefined;
  const path = value.trim();
  if (path.split("/").includes("..")) return undefined;
  if (!posix.isAbsolute(path)) return path.startsWith("~") ? undefined : path;
  for (const root of roots) {
    if (!posix.isAbsolute(root) || root === "/") continue;
    const base = posix.normalize(root).replace(/\/$/, "");
    if (path === base || path.startsWith(`${base}/`)) return posix.relative(base, path) || ".";
  }
  return undefined;
}

/** @param {string[]} lines @param {boolean} [partial] */
function preview(lines, partial = false) {
  const text = lines.join("\n");
  const body = text.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, "");
  return { body, truncated: partial || body.length < text.length };
}

/** Only whitelisted file-change fields from an item notification are read.
 * No raw item or diff is retained in the runner's bounded display cache.
 * @param {unknown} changes @param {readonly string[]} roots */
export function codexFileChangePreview(changes, roots = []) {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const lines = ["Files:"];
  for (const change of changes.slice(0, 20)) {
    const path = displayPath(change?.path, roots);
    if (!path) { lines.push("File target withheld or unavailable."); continue; }
    const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
    lines.push(`${["add", "delete", "update"].includes(kind) ? kind : "change"}: ${path}`);
    if (kind === "update" && typeof change.kind === "object" && change.kind?.move_path != null) {
      lines.push(`Move to: ${displayPath(change.kind.move_path, roots) ?? "Unavailable or withheld for privacy."}`);
    }
    if (typeof change.diff === "string" && change.diff.trim()) lines.push(`Patch:\n${displayText(change.diff, roots)}`);
    else lines.push("Patch unavailable: not supplied by the agent.");
  }
  return preview(lines, changes.length > 20);
}

/** Both detached runner and direct normalizer use this privacy boundary.
 * Native identities/amendments and unrecognized fields never enter the copy.
 * @param {string} method @param {Record<string, unknown>} params
 * @param {{ writableRoots?: readonly string[], filePreview?: {body?: string,truncated: boolean} }} [context] */
export function codexApprovalDisplay(method, params, context = {}) {
  const roots = context.writableRoots ?? [];
  if (method === "item/commandExecution/requestApproval") {
    const lines = [`Command:\n${displayText(params.command, roots)}`,
      `Working directory: ${displayPath(params.cwd, roots) ?? "Unavailable or withheld for privacy."}`];
    if (params.reason != null) lines.push(`Reason: ${displayText(params.reason, roots)}`);
    return { title: "Run command", safeDescription: "The coding agent wants to run a command.",
      actionKind: "command", risk: "medium", preview: preview(lines) };
  }
  if (method === "item/fileChange/requestApproval") {
    const lines = [context.filePreview?.body ?? "Files and patch unavailable: not supplied by the agent."];
    if (params.grantRoot != null) lines.push(`Requested write root: ${displayPath(params.grantRoot, roots) ?? "Unavailable or withheld for privacy."}`);
    if (params.reason != null) lines.push(`Reason: ${displayText(params.reason, roots)}`);
    return { title: "Change files", safeDescription: "The coding agent wants to change project files.",
      actionKind: "file_change", risk: "medium", preview: preview(lines, context.filePreview?.truncated) };
  }
  return { title: "Change permissions", safeDescription: "The coding agent wants additional permissions.", actionKind: "provider", risk: "high" };
}
