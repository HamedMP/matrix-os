import { isAbsolute, relative, sep } from "node:path";

const SECRET_TEXT = /(?:authorization\s*[:=]|bearer\s+|(?:api[_-]?(?:key|token)|access[_-]?token|secret|password|credential)\s*[:=]|\bprivate\s+raw\b|ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]+)/i;
const SECRET_ASSIGNMENT = /\b(?:API[_-]?KEY|API[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL)\s*=\s*[^\s,;]+/gi;
const ABSOLUTE_PATH = /(^|[\s"'`(=:<>|;&])\/(?=[A-Za-z0-9._~-])(?!\/)[^\s"'`<>)]*/g;
const DANGLING_BEARER = /(?:^|[^A-Za-z0-9_])Bearer\s+$/i;
const ACTIVE_BEARER = /(?:^|[^A-Za-z0-9_])Bearer\s+/i;
const DANGLING_SECRET_ASSIGNMENT = /(?:^|[^A-Za-z0-9_])(?:API[_-]?(?:KEY|TOKEN)|ACCESS[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL)\s*(?:=\s*)?$/i;
const SECRET_KEYWORDS = [
  "bearer", "apikey", "api_key", "api-key", "apitoken", "api_token", "api-token",
  "accesstoken", "access_token", "access-token", "secret", "password", "credential",
] as const;
const ASSISTANT_TEXT_TAIL_LIMIT = 2_048;

function normalizedRoot(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

export function safeDisplayPath(
  value: unknown,
  options: { homePath: string; executionRoot?: string },
): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!path || path.includes("\0") || SECRET_TEXT.test(path)) return undefined;
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

/** Project streamed text only after its path or credential token is complete. */
export function createAssistantTextStreamProjector(options: { homePath: string; executionRoot?: string }) {
  let pending = "";
  let droppingOversizedToken = false;
  const spacedRoots = [options.homePath, options.executionRoot]
    .filter((root): root is string => root !== undefined && /\s/u.test(root))
    .map((root) => `${normalizedRoot(root)}/`);
  const incompleteKnownRoot = () => {
    for (let index = pending.indexOf("/"); index >= 0; index = pending.indexOf("/", index + 1)) {
      const prefix = index === 0 ? "" : pending[index - 1]!;
      if (prefix && !/[\s"'`(=:<>|;&]/u.test(prefix)) continue;
      const suffix = pending.slice(index);
      if (spacedRoots.some((root) => root.startsWith(suffix))) return true;
    }
    return false;
  };
  const incompleteSecretKeyword = () => {
    const token = /[A-Za-z][A-Za-z0-9_-]*$/u.exec(pending)?.[0].toLowerCase();
    return token !== undefined && SECRET_KEYWORDS.some((keyword) => keyword.startsWith(token));
  };

  return {
    push(value: string): string {
      let projected = "";
      for (const character of value) {
        if (droppingOversizedToken) {
          if (/\s/u.test(character)) {
            droppingOversizedToken = false;
            projected += character;
          }
          continue;
        }

        pending += character;
        if (/\s/u.test(character)
          && !DANGLING_BEARER.test(pending)
          && !DANGLING_SECRET_ASSIGNMENT.test(pending)
          && !incompleteKnownRoot()) {
          projected += sanitizeAssistantText(pending, options);
          pending = "";
        } else if (character.codePointAt(0)! > 0x7f
          && !/\s/u.test(character)
          && !pending.includes("/")
          && !ACTIVE_BEARER.test(pending)
          && sanitizeAssistantText(pending, options) === pending) {
          // Ordinary unspaced Unicode prose can stream; path/URL and secret
          // candidates stay whole. Keep one character so a later slash can
          // still be recognized as part of a relative path.
          projected += pending.slice(0, -character.length);
          pending = character;
        } else if (pending.length > ASSISTANT_TEXT_TAIL_LIMIT) {
          pending = "";
          droppingOversizedToken = true;
          projected += "[redacted]";
        }
      }
      return projected;
    },
    flushBoundary(nextCharacter?: string): string {
      if (droppingOversizedToken || pending.includes("/") || ACTIVE_BEARER.test(pending)
        || DANGLING_SECRET_ASSIGNMENT.test(pending)
        || incompleteSecretKeyword()
        || /https?:$/iu.test(pending)
        || sanitizeAssistantText(pending, options) !== pending) return "";
      // At a new text block, a plain word is complete unless the new block
      // starts a slash continuation (relative path) or a URL scheme colon.
      // Releasing it preserves the new block's word boundary for credentials.
      if ((nextCharacter === undefined || nextCharacter === "/"
        || (nextCharacter === ":" && /https?$/iu.test(pending)))
        && /[\p{L}\p{N}_~-]$/u.test(pending)) return "";
      const projected = pending;
      pending = "";
      return projected;
    },
    hasPending(): boolean {
      return pending.length > 0 || droppingOversizedToken;
    },
    flush(): string {
      if (droppingOversizedToken) {
        droppingOversizedToken = false;
        pending = "";
        return "";
      }
      const projected = sanitizeAssistantText(pending, options);
      pending = "";
      return projected;
    },
    discard(): void {
      pending = "";
      droppingOversizedToken = false;
    },
  };
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
  const path = safeDisplayPath(
    values.path ?? values.file_path ?? values.filePath ?? values.file ?? values.directory ?? values.dir,
    options,
  );
  if (["read", "read_file", "list", "list_files", "ls"].includes(normalizedName)) {
    return path ? { preview: path, previewKind: "path" } : {};
  }
  if (["glob", "find", "find_files", "grep", "search", "search_files"].includes(normalizedName)) {
    const query = safePublishedText(values.pattern ?? values.query ?? values.glob, {
      ...options,
      maxChars: 1_000,
    });
    if (query) {
      return {
        preview: query,
        previewKind: "text",
        ...(path ? { detail: `In: ${path}` } : {}),
      };
    }
    return path ? { preview: path, previewKind: "path" } : {};
  }
  if (["write", "edit", "patch", "replace"].includes(normalizedName)
    || /^(?:write|edit|patch|replace|apply)_?file$/.test(normalizedName)
    || normalizedName === "apply_patch") {
    return path ? { preview: path, previewKind: "path" } : {};
  }
  return {};
}

export function safeToolActivity(
  name: string,
  args: unknown,
  options: { homePath: string; executionRoot?: string },
): {
  displayName: string;
  kind: "command" | "file_change" | "dynamic_tool" | "web_search";
  preview?: string;
  previewKind?: "command" | "path" | "text";
  detail?: string;
} {
  const normalizedName = name.trim().toLowerCase();
  const activity = ["terminal", "shell", "bash", "execute", "execute_code", "run_command"]
    .includes(normalizedName)
    ? { displayName: "Run command", kind: "command" as const }
    : ["write", "edit", "patch", "replace", "apply_patch"].includes(normalizedName)
        || /^(?:write|edit|patch|replace|apply)_?file$/.test(normalizedName)
      ? { displayName: "Update file", kind: "file_change" as const }
      : ["read", "read_file"].includes(normalizedName)
        ? { displayName: "Read file", kind: "dynamic_tool" as const }
        : ["list", "list_files", "ls"].includes(normalizedName)
          ? { displayName: "List files", kind: "dynamic_tool" as const }
          : ["glob", "find", "find_files"].includes(normalizedName)
            ? { displayName: "Find files", kind: "dynamic_tool" as const }
            : ["grep", "search", "search_files"].includes(normalizedName)
              ? { displayName: "Search files", kind: "dynamic_tool" as const }
              : ["web_search", "websearch", "webfetch"].includes(normalizedName)
                ? { displayName: "Search the web", kind: "web_search" as const }
                : { displayName: "Use tool", kind: "dynamic_tool" as const };
  return {
    ...activity,
    ...safeToolPreview(normalizedName, args, options),
  };
}
