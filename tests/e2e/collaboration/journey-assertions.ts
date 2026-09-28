/** Browser-side evidence for the account-only entry. Retains paths only, never credentials or query strings. */
const FORBIDDEN_PREFIXES = [
  "/api/journey", "/api/system", "/api/terminal", "/api/desktop", "/api/theme",
  "/api/auth/ws-token", "/api/billing", "/api/vps", "/api/provision",
  "/api/runtime", "/files", "/checkout",
] as const;

interface RequestSource {
  on(event: "request", listener: (request: { url(): string }) => void): unknown;
  off(event: "request", listener: (request: { url(): string }) => void): unknown;
}

export function classifyAccountOnlyRequest(path: string): "allowed" | "forbidden" {
  return FORBIDDEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    ? "forbidden" : "allowed";
}

export function assertMachineFreeJourney(value: { computers: readonly { handle: string }[]; phase: string }): void {
  if (value.computers.length !== 0) throw new Error("Account-only journey requires zero computers");
  if (value.phase !== "plan_required") throw new Error("Account-only journey requires plan_required phase");
}

export function assertNonDisclosingDenial(error: unknown, sensitiveValues: readonly string[]): void {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "denied") {
    throw new Error("Direct transport did not deny the request");
  }
  const message = error.message;
  if (message.length > 160 || /https?:\/\/|\/api\/|\/(?:home|opt|etc)\/|clerk|stripe|postgres/i.test(message)
    || sensitiveValues.some((value) => value.length > 0 && message.includes(value))) {
    throw new Error("Direct transport denial disclosed a sensitive detail");
  }
}

export function recordAccountOnlyRequests(page: RequestSource, baseUrl: string, maxPaths = 256) {
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 1_024) throw new Error("Invalid request recorder capacity");
  const origin = new URL(baseUrl).origin;
  const paths: string[] = [];
  let overflow = false;
  const onRequest = (request: { url(): string }) => {
    let url: URL;
    try { url = new URL(request.url()); }
    catch { overflow = true; return; }
    if (url.origin !== origin) return;
    if (paths.length === maxPaths) { overflow = true; return; }
    paths.push(url.pathname);
  };
  page.on("request", onRequest);
  return {
    paths: () => [...paths],
    assertNoForbiddenRequests() {
      if (overflow) throw new Error("Account-only request recorder exceeded capacity");
      const forbidden = paths.filter((path) => classifyAccountOnlyRequest(path) === "forbidden");
      if (forbidden.length) throw new Error(`Account-only journey issued forbidden requests: ${[...new Set(forbidden)].join(", ")}`);
    },
    stop() { page.off("request", onRequest); },
  };
}
