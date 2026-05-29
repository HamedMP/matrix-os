export type EnvSource = Record<string, string | undefined>;

export interface PostHogClientConfig {
  token: string;
  apiHost?: string;
  uiHost?: string;
}

export interface ResolvePostHogClientApiHostOptions {
  allowRelativeApiHost?: boolean;
}

export interface HeadersLike {
  get(name: string): string | null;
}

const CLIENT_TOKEN_ENV_KEYS = ["NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "NEXT_PUBLIC_POSTHOG_KEY"];
const CLIENT_API_HOST_ENV_KEYS = ["NEXT_PUBLIC_POSTHOG_API_HOST"];
const CLIENT_UI_HOST_ENV_KEYS = ["NEXT_PUBLIC_POSTHOG_HOST"];
const GEO_COUNTRY_HEADERS = [
  "x-vercel-ip-country",
  "cf-ipcountry",
  "cloudfront-viewer-country",
  "x-country-code",
  "x-geo-country",
];
const POSTHOG_COOKIE_CONSENT_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
  "CH",
]);

export function getPostHogClientConfig(env: EnvSource = process.env): PostHogClientConfig | null {
  const token = firstEnv(env, CLIENT_TOKEN_ENV_KEYS);
  if (!token) return null;
  const apiHost = firstEnv(env, CLIENT_API_HOST_ENV_KEYS);
  const uiHost = firstEnv(env, CLIENT_UI_HOST_ENV_KEYS);
  return {
    token,
    ...(apiHost ? { apiHost } : {}),
    ...(uiHost ? { uiHost } : {}),
  };
}

export function resolvePostHogClientApiHost(
  config: PostHogClientConfig,
  options: ResolvePostHogClientApiHostOptions = {},
): string | undefined {
  const allowRelativeApiHost = options.allowRelativeApiHost ?? true;
  if (config.apiHost && (allowRelativeApiHost || isAbsoluteHttpUrl(config.apiHost))) {
    return config.apiHost;
  }
  return config.uiHost;
}

export function getPostHogVisitorCountry(headers: HeadersLike): string | null {
  for (const header of GEO_COUNTRY_HEADERS) {
    const country = normalizeCountryCode(headers.get(header));
    if (country) return country;
  }
  return null;
}

export function requiresPostHogCookieConsent(countryCode: string | null | undefined): boolean {
  const country = normalizeCountryCode(countryCode);
  return country ? POSTHOG_COOKIE_CONSENT_COUNTRIES.has(country) : false;
}

export function buildPostHogCookieConsentInitOptions(
  countryCode: string | null | undefined,
): Record<string, "on_reject"> {
  return requiresPostHogCookieConsent(countryCode) ? { cookieless_mode: "on_reject" } : {};
}

function firstEnv(env: EnvSource, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (err: unknown) {
    if (err instanceof TypeError) return false;
    throw err;
  }
}

function normalizeCountryCode(countryCode: string | null | undefined): string | null {
  const country = countryCode?.trim().toUpperCase();
  if (!country || country === "UNKNOWN" || !/^[A-Z]{2}$/.test(country)) return null;
  return country;
}
