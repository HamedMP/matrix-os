import type { MatrixAppEntry, MatrixAppManifestResponse } from "../lib/apps";

export const MOBILE_GATEWAY_URL = "https://app.matrix-os.test";

export function mockMatrixApp(overrides: Partial<MatrixAppEntry> = {}): MatrixAppEntry {
  const slug = overrides.slug ?? "notes";
  return {
    name: "Notes",
    description: "Write and organize notes.",
    category: "Productivity",
    file: `${slug}/index.html`,
    path: `/files/apps/${slug}/index.html`,
    slug,
    runtime: "vite",
    runtimeState: { status: "ready" },
    ...overrides,
  };
}

export function mockAppManifest(
  overrides: Partial<MatrixAppManifestResponse> = {},
): MatrixAppManifestResponse {
  return {
    manifest: {
      name: "Notes",
      description: "Write and organize notes.",
      category: "Productivity",
      runtime: "vite",
    },
    runtimeState: { status: "ready" },
    distributionStatus: { status: "installed" },
    ...overrides,
  };
}

export function mockSessionToken(slug = "notes"): { token: string; launchUrl: string; expiresAt: string } {
  return {
    token: `session-token-${slug}`,
    launchUrl: `/apps/${slug}/?token=session-token-${slug}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

export function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  const text = typeof body === "string" ? body : JSON.stringify(body);

  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(text),
    clone: jest.fn(() => jsonResponse(body, { ok, status })),
  } as unknown as Response;
}

export function installGatewayFetchMock(
  routes: Record<string, unknown | Response>,
): jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>> {
  return jest.spyOn(global, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const path = safePathname(url);
    const route = routes[url] ?? routes[path];

    if (isResponseLike(route)) {
      return route;
    }

    return jsonResponse(route ?? {});
  });
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isResponseLike(value: unknown): value is Response {
  return Boolean(
    value &&
    typeof value === "object" &&
    "json" in value &&
    "ok" in value &&
    "status" in value,
  );
}
