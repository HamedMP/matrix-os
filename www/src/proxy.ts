import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/admin(.*)"]);

const withClerk = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

function normalizeCsp(policy: string): string {
  return policy.replace(/\s{2,}/g, " ").trim();
}

function buildContentSecurityPolicy(nonce: string): string {
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
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https:${devScriptPolicy};
    connect-src 'self' https://app.matrix-os.com https://api.matrix-os.com https://clerk.matrix-os.com https://*.clerk.com https://*.clerk.accounts.dev https://eu.i.posthog.com https://eu-assets.i.posthog.com;
    frame-src 'self' https://app.matrix-os.com https://clerk.matrix-os.com https://*.clerk.com https://*.clerk.accounts.dev;
    worker-src 'self' blob:;
    upgrade-insecure-requests;
  `);
}

function applySecurityHeaders(request: Parameters<typeof withClerk>[0]) {
  const nonce = btoa(crypto.randomUUID());
  const requestHeaders = new Headers(request.headers);
  const csp = buildContentSecurityPolicy(nonce);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "browsing-topics=(), interest-cohort=()");
  return response;
}

export default function proxy(
  request: Parameters<typeof withClerk>[0],
  event: Parameters<typeof withClerk>[1],
) {
  if (isProtectedRoute(request)) {
    return withClerk(request, event);
  }
  return applySecurityHeaders(request);
}

export const config = {
  matcher: ["/dashboard(.*)", "/admin(.*)", "/((?!_next|.*\\..*).*)"],
};
