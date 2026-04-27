import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { shellError } from "./errors.js";

const SESSION_SLUG = /^[a-z][a-z0-9-]{0,30}$/;
const LONG_SLUG = /^[a-z][a-z0-9-]{0,63}$/;

function validateSlug(value: string, regex: RegExp, code: string): string {
  if (!regex.test(value)) {
    throw shellError(code, "Invalid request", 400);
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

export async function resolveShellCwd(rawCwd: string | undefined, homePath: string): Promise<string> {
  if (!rawCwd || rawCwd === "~") {
    return realpathWithinHome(resolve(homePath), resolve(homePath));
  }

  const homeRoot = resolve(homePath);
  const expanded = rawCwd.startsWith("~/") ? rawCwd.slice(2) : rawCwd;
  const candidate = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(homeRoot, expanded);
  const homePrefix = homeRoot.endsWith(sep) ? homeRoot : `${homeRoot}${sep}`;

  if (candidate !== homeRoot && !candidate.startsWith(homePrefix)) {
    throw shellError("invalid_cwd", "Invalid cwd", 400);
  }

  return realpathWithinHome(candidate, homeRoot);
}

async function realpathWithinHome(candidate: string, homeRoot: string): Promise<string> {
  try {
    const [candidateReal, homeReal] = await Promise.all([
      realpath(candidate),
      realpath(homeRoot),
    ]);
    const homePrefix = homeReal.endsWith(sep) ? homeReal : `${homeReal}${sep}`;
    if (candidateReal !== homeReal && !candidateReal.startsWith(homePrefix)) {
      throw shellError("invalid_cwd", "Invalid cwd", 400);
    }
    return candidateReal;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && "safeMessage" in err) {
      throw err;
    }
    throw shellError("invalid_cwd", "Invalid cwd", 400);
  }
}
