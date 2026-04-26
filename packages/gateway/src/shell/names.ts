import { isAbsolute, resolve, sep } from "node:path";

const SESSION_SLUG = /^[a-z][a-z0-9-]{0,30}$/;
const LONG_SLUG = /^[a-z][a-z0-9-]{0,63}$/;

function validateSlug(value: string, regex: RegExp, code: string): string {
  if (!regex.test(value)) {
    throw Object.assign(new Error(code), { code });
  }
  return value;
}

export function validateSessionName(value: string): string {
  return validateSlug(value, SESSION_SLUG, "invalid_session_name");
}

export function validateProfileName(value: string): string {
  return validateSlug(value, SESSION_SLUG, "invalid_profile_name");
}

export function validateLayoutName(value: string): string {
  return validateSlug(value, LONG_SLUG, "invalid_layout_name");
}

export function resolveShellCwd(rawCwd: string | undefined, homePath: string): string {
  if (!rawCwd || rawCwd === "~") {
    return resolve(homePath);
  }

  const homeRoot = resolve(homePath);
  const expanded = rawCwd.startsWith("~/") ? rawCwd.slice(2) : rawCwd;
  const candidate = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(homeRoot, expanded);
  const homePrefix = homeRoot.endsWith(sep) ? homeRoot : `${homeRoot}${sep}`;

  if (candidate !== homeRoot && !candidate.startsWith(homePrefix)) {
    throw Object.assign(new Error("invalid_cwd"), { code: "invalid_cwd" });
  }

  return candidate;
}
