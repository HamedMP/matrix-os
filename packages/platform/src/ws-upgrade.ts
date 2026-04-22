export function isSafeWebSocketUpgradePath(path: string): boolean {
  return !/[\r\n]/.test(path);
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export function getWebSocketUpgradeHost(
  hostHeader: string | string[] | undefined,
  forwardedHostHeader: string | string[] | undefined,
): string {
  const forwarded = normalizeHeaderValue(forwardedHostHeader)
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  if (forwarded) {
    return forwarded;
  }

  return normalizeHeaderValue(hostHeader).trim();
}

function parseWebSocketUpgradeUrl(path: string): URL | null {
  try {
    return new URL(path, "http://platform.invalid");
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      return null;
    }
    throw err;
  }
}

export function getWebSocketUpgradeToken(path: string): string | null {
  const parsed = parseWebSocketUpgradeUrl(path);
  return parsed?.searchParams.get("token") ?? null;
}

export function stripWebSocketUpgradeToken(path: string): string {
  const parsed = parseWebSocketUpgradeUrl(path);
  if (!parsed) {
    return path;
  }
  parsed.searchParams.delete("token");
  const search = parsed.searchParams.toString();
  return `${parsed.pathname}${search ? `?${search}` : ""}`;
}
