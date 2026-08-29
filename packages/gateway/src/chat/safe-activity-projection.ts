import { isAbsolute, relative, sep } from "node:path";

const SECRET_TEXT = /(?:authorization\s*[:=]|bearer\s+|(?:api[_-]?(?:key|token)|access[_-]?token|secret|password|credential)\s*[:=]|\bprivate\s+raw\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]+)/i;
const SECRET_ASSIGNMENT = /\b(?:API[_-]?KEY|API[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL)\s*=\s*[^\s,;]+/gi;
const ABSOLUTE_PATH = /(^|[\s"'`(=:])\/(?!\/)[^\s"'`<>)]*/g;

function normalizedRoot(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

export function safeDisplayPath(
  value: unknown,
  options: { homePath: string; executionRoot?: string },
): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!path || path.includes("\0")) return undefined;
  const homePath = normalizedRoot(options.homePath);
  const executionRoot = options.executionRoot ? normalizedRoot(options.executionRoot) : undefined;
  if (path === homePath) return "~";
  if (path.startsWith(`${homePath}${sep}`) || path.startsWith(`${homePath}/`)) {
    return `~/${path.slice(homePath.length + 1).replaceAll("\\", "/")}`;
  }
  if (executionRoot && (path === executionRoot || path.startsWith(`${executionRoot}${sep}`) || path.startsWith(`${executionRoot}/`))) {
    const projected = relative(executionRoot, path).replaceAll("\\", "/");
    return projected || ".";
  }
  if (isAbsolute(path)) return undefined;
  if (path.startsWith("~")) return /^~\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/.test(path) ? path : undefined;
  if (path.split(/[\\/]+/).some((part) => part === "" || part === "." || part === "..")) return undefined;
  return path.replaceAll("\\", "/");
}

export function safePublishedText(
  value: unknown,
  options: { homePath: string; executionRoot?: string; maxChars?: number },
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || SECRET_TEXT.test(trimmed)) return undefined;
  const homePath = normalizedRoot(options.homePath);
  const executionRoot = options.executionRoot ? normalizedRoot(options.executionRoot) : undefined;
  let projected = trimmed.replaceAll(`${homePath}/`, "~/").replaceAll(homePath, "~");
  if (executionRoot && !executionRoot.startsWith(`${homePath}/`)) {
    projected = projected.replaceAll(`${executionRoot}/`, "").replaceAll(executionRoot, ".");
  }
  projected = projected.replace(ABSOLUTE_PATH, (match, prefix: string) => `${prefix}[redacted path]`);
  const maxChars = options.maxChars ?? 2_000;
  return Array.from(projected).slice(0, maxChars).join("");
}

export function sanitizeAssistantText(
  value: string,
  options: { homePath: string; executionRoot?: string },
): string {
  const homePath = normalizedRoot(options.homePath);
  const executionRoot = options.executionRoot ? normalizedRoot(options.executionRoot) : undefined;
  let projected = value.replaceAll(`${homePath}/`, "~/").replaceAll(homePath, "~");
  if (executionRoot && !executionRoot.startsWith(`${homePath}/`)) {
    projected = projected.replaceAll(`${executionRoot}/`, "").replaceAll(executionRoot, ".");
  }
  return projected
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT, "[redacted credential]")
    .replace(ABSOLUTE_PATH, (match, prefix: string) => `${prefix}[redacted path]`);
}

export function safeToolPreview(
  name: string,
  args: unknown,
  options: { homePath: string; executionRoot?: string },
): { preview?: string; previewKind?: "command" | "path" | "text"; detail?: string } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const values = args as Record<string, unknown>;
  const normalizedName = name.trim().toLowerCase();
  const cwd = safeDisplayPath(values.cwd, options);
  const detail = cwd ? `Working directory: ${cwd}` : undefined;
  if (["terminal", "shell", "bash", "execute", "execute_code", "run_command"].includes(normalizedName)) {
    const command = safePublishedText(values.command ?? values.cmd, { ...options, maxChars: 1_000 });
    return command ? { preview: command, previewKind: "command", ...(detail ? { detail } : {}) } : {};
  }
  if (/^(?:write|edit|patch|replace|apply)_?file$/.test(normalizedName) || normalizedName === "apply_patch") {
    const path = safeDisplayPath(values.path ?? values.file_path ?? values.file, options);
    return path ? { preview: path, previewKind: "path" } : {};
  }
  return {};
}
