import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/admin(.*)"]);

const withClerk = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

type ProxyRequest = Parameters<typeof withClerk>[0];
type ProxyEvent = Parameters<typeof withClerk>[1];
type ProtectedRouteAuthorizer = (
  request: ProxyRequest,
  event: ProxyEvent,
) => ReturnType<typeof withClerk>;

function normalizeCsp(policy: string): string {
  return policy.replace(/\s{2,}/g, " ").trim();
}

function buildContentSecurityPolicy(): string {
  const devScriptPolicy = process.env.NODE_ENV === "development" ? " 'unsafe-eval' http:" : "";
  return normalizeCsp(`
    default-src 'self';
    base-uri 'self';
    object-src 'none';
    frame-ancestors 'self';
    form-action 'self' https://app.matrix-os.com;
    img-src 'self' blob: data: https:;
    font-src 'self' data:;
    style-src 'self' 'unsafe-inline';
    script-src 'self' 'unsafe-inline' https://clerk.matrix-os.com https://*.clerk.com https://*.clerk.accounts.dev https://eu-assets.i.posthog.com https://tally.so${devScriptPolicy};
    connect-src 'self' https://app.matrix-os.com https://api.matrix-os.com https://clerk.matrix-os.com https://*.clerk.com https://*.clerk.accounts.dev https://eu.i.posthog.com https://eu-assets.i.posthog.com https://tally.so;
    frame-src 'self' https://app.matrix-os.com https://clerk.matrix-os.com https://*.clerk.com https://*.clerk.accounts.dev https://tally.so;
    worker-src 'self' blob:;
    upgrade-insecure-requests;
  `);
}

function createSecurityResponse() {
  const csp = buildContentSecurityPolicy();
  const response = NextResponse.next();
  return applySecurityHeaders(response, csp);
}

function applySecurityHeaders(response: NextResponse, csp: string) {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "browsing-topics=(), interest-cohort=()");
  return response;
}

function applySecurityResponseHeaders(response: Response, securityResponse: NextResponse) {
  for (const [name, value] of securityResponse.headers) {
    if (name === "x-middleware-override-headers") {
      const merged = [
        ...(response.headers.get(name)?.split(",") ?? []),
        ...value.split(","),
      ]
        .map((header) => header.trim())
        .filter((header, index, headers) => header.length > 0 && headers.indexOf(header) === index)
        .join(",");
      response.headers.set(name, merged);
      continue;
    }

    if (
      name === "content-security-policy" ||
      name === "cross-origin-opener-policy" ||
      name === "permissions-policy" ||
      name.startsWith("x-middleware-request-")
    ) {
      response.headers.set(name, value);
    }
  }
  return response;
}

export async function proxyWithSecurity(
  request: ProxyRequest,
  event: ProxyEvent,
  authorizeProtectedRoute: ProtectedRouteAuthorizer = withClerk,
) {
  const securityResponse = createSecurityResponse();
  if (isProtectedRoute(request)) {
    const clerkResponse = await authorizeProtectedRoute(request, event);
    return applySecurityResponseHeaders(clerkResponse ?? NextResponse.next(), securityResponse);
  }
  return securityResponse;
}

export default proxyWithSecurity;

export const config = {
  matcher: ["/dashboard(.*)", "/admin(.*)", "/((?!_next|.*\\..*).*)"],
};
