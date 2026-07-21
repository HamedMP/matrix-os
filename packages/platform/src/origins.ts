// Canonical origin authority (spec 092 R6). One place resolves the app / api /
// www origins per environment, and validates client-influenced return paths
// against an allowlist — so auth, billing-return, and session-handoff redirects
// stop being assembled from scattered hardcoded literals and header guesses
// (the recurring redirect-bug class).

const DEFAULT_APP_ORIGIN = 'https://app.matrix-os.com';
const DEFAULT_API_ORIGIN = 'https://api.matrix-os.com';
const DEFAULT_WWW_ORIGIN = 'https://matrix-os.com';

// Returns the URL origin, or null if `value` isn't a parseable absolute URL or
// yields an opaque origin (the string "null") — e.g. a schemeless `localhost:3000`.
function tryOrigin(value: string): string | null {
  try {
    const { origin } = new URL(value);
    return origin && origin !== 'null' ? origin : null;
  } catch (err: unknown) {
    return null;
  }
}

function normalizeOrigin(value: string): string {
  const direct = tryOrigin(value);
  if (direct) return direct;
  // Repair common misconfigs (bare host / schemeless `localhost:3000`) by
  // assuming https rather than letting an opaque "null" origin poison every
  // redirect URL silently.
  const prefixed = tryOrigin(`https://${value.replace(/^\/+/, '')}`);
  if (prefixed) return prefixed;
  return value.replace(/\/+$/, '');
}

/** The app shell / auth door origin (e.g. https://app.matrix-os.com). */
export function appOrigin(env: NodeJS.ProcessEnv = process.env): string {
  // PLATFORM_PUBLIC_URL is the platform/API URL — NOT an app-origin fallback
  // (using it here would aim the app door at the API host). It belongs to
  // apiOrigin only.
  return normalizeOrigin(
    env.MATRIX_APP_ORIGIN ?? env.NEXT_PUBLIC_MATRIX_APP_URL ?? DEFAULT_APP_ORIGIN,
  );
}

/** The platform API origin (e.g. https://api.matrix-os.com). PLATFORM_PUBLIC_URL
 *  is the platform's public (API) URL, so it is the correct fallback here. */
export function apiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeOrigin(env.MATRIX_API_ORIGIN ?? env.PLATFORM_PUBLIC_URL ?? DEFAULT_API_ORIGIN);
}

/** The marketing-site origin (e.g. https://matrix-os.com). */
export function wwwOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeOrigin(env.MATRIX_WWW_ORIGIN ?? DEFAULT_WWW_ORIGIN);
}

// Allowlisted post-auth/billing return paths. Anything off this list falls back
// to "/", so a client-supplied returnPath can never become an open redirect.
const RETURN_PATH_ALLOWLIST: RegExp[] = [
  /^\/$/,
  /^\/\?billing=setup&handoff=add-computer$/,
  /^\/sign-in(?:[/?].*)?$/,
  /^\/sign-up(?:[/?].*)?$/,
  /^\/runtime(?:[/?].*)?$/,
  /^\/onboarding\/computer(?:\?.*)?$/,
  /^\/vm\/[a-z0-9][a-z0-9-]{0,63}(?:[/?].*)?$/,
  /^\/auth\/device(?:[/?].*)?$/,
];

// Rejects any control character or space (code point <= 0x20). Implemented with
// charCodeAt rather than a regex literal to keep control chars out of source.
function hasUnsafePathChar(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    if (path.charCodeAt(i) <= 0x20) return true;
  }
  return false;
}

/**
 * Validates a client-influenced return path. Returns the path only if it is a
 * same-origin absolute path on the allowlist; otherwise returns "/". Rejects
 * absolute URLs, protocol-relative (`//host`), backslash, control, and traversal.
 */
export function resolveReturnPath(path: string | undefined | null): string {
  if (typeof path !== 'string' || path.length === 0) return '/';
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  if (path.includes('\\') || path.includes('..') || hasUnsafePathChar(path)) return '/';
  try {
    const url = new URL(path, 'https://return-path.invalid');
    const candidate = `${url.pathname}${url.search}`;
    return RETURN_PATH_ALLOWLIST.some((re) => re.test(candidate)) ? candidate : '/';
  } catch (err: unknown) {
    // Unparseable path → safe default. The fallback IS the handling.
    return '/';
  }
}

/** Builds an absolute app-origin URL for a validated return path. */
export function appReturnUrl(path: string | undefined | null, env: NodeJS.ProcessEnv = process.env): string {
  return new URL(resolveReturnPath(path), `${appOrigin(env)}/`).toString();
}
