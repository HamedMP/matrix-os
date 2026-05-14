import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isGatewayProxyPath, isPublicShellPath } from "./src/lib/proxy-routes";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";
const authToken = process.env.MATRIX_AUTH_TOKEN;
const expectedClerkUserId = process.env.MATRIX_CLERK_USER_ID;
const platformUpgradeToken = process.env.UPGRADE_TOKEN;

interface ProxyRequestLike {
  headers: Headers;
  nextUrl: {
    host: string;
    pathname: string;
    protocol: string;
    search: string;
  };
}

// Direct path check instead of Clerk's createRouteMatcher -- in Next 16's
// proxy.ts runtime, createRouteMatcher has been observed to return false for
// paths it should match, causing gateway-bound requests (/api/*, /files/*,
// /apps/*) to fall through to the 404 page instead of being rewritten to the
// gateway.
function isGatewayProxy(request: ProxyRequestLike): boolean {
  return isGatewayProxyPath(request.nextUrl.pathname);
}

function getPublicOrigin(request: ProxyRequestLike) {
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    request.nextUrl.protocol.replace(":", "") ??
    "https";

  return `${proto}://${host}`;
}

function rewriteGatewayRequest(request: ProxyRequestLike) {
  const { pathname } = request.nextUrl;
  const target = pathname.startsWith("/gateway/")
    ? pathname.replace("/gateway", "")
    : pathname;
  const url = new URL(target + request.nextUrl.search, gatewayUrl);
  const headers = new Headers(request.headers);
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  return NextResponse.rewrite(url, { request: { headers } });
}

function platformVerifiedResponse(request: ProxyRequestLike): NextResponse | null {
  const platformAuthHeader = request.headers.get("authorization");
  const platformBearer = platformAuthHeader?.startsWith("Bearer ")
    ? platformAuthHeader.slice(7)
    : null;
  if (!platformUpgradeToken || platformBearer !== platformUpgradeToken) {
    return null;
  }

  const platformUserId = request.headers.get("x-platform-user-id");
  if (expectedClerkUserId && platformUserId !== expectedClerkUserId) {
    return new NextResponse("Forbidden: you do not own this instance", {
      status: 403,
    });
  }

  if (isGatewayProxy(request)) {
    return rewriteGatewayRequest(request);
  }

  return NextResponse.next();
}

// Clerk handler for authenticated routes
const withClerk = clerkMiddleware(async (auth, request) => {
  // Layer 1: Clerk authentication (skip public routes)
  if (!isPublicShellPath(request.nextUrl.pathname)) {
    const { userId } = await auth();
    if (!userId) {
      const publicOrigin = getPublicOrigin(request);
      const signInUrl = new URL("/sign-in", publicOrigin);
      const redirectUrl = new URL(
        `${request.nextUrl.pathname}${request.nextUrl.search}`,
        publicOrigin,
      );
      signInUrl.searchParams.set("redirect_url", redirectUrl.toString());
      return NextResponse.redirect(signInUrl);
    }
  }

  // Layer 2: Owner verification -- fail closed when configured (skip public routes)
  if (expectedClerkUserId && !isPublicShellPath(request.nextUrl.pathname)) {
    const { userId } = await auth();
    if (userId !== expectedClerkUserId) {
      return new NextResponse("Forbidden: you do not own this instance", {
        status: 403,
      });
    }
  }

  // Proxy gateway API and file requests
  if (isGatewayProxy(request)) {
    return rewriteGatewayRequest(request);
  }

  return NextResponse.next();
});

export function proxy(
  request: Parameters<typeof withClerk>[0],
  event: Parameters<typeof withClerk>[1],
) {
  // E2E screenshot tests run against `next start`, which always serves the
  // built app with production semantics. Use the explicit bypass flag alone so
  // screenshot runs can skip auth without depending on NODE_ENV.
  if (process.env.E2E_TEST_BYPASS === "1") {
    return NextResponse.next();
  }
  // Platform already verified the Clerk session. Handle this before invoking
  // Clerk so customer VPS shells do not require CLERK_SECRET_KEY.
  const platformResponse = platformVerifiedResponse(request);
  if (platformResponse) {
    return platformResponse;
  }
  if (isPublicShellPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  // All requests -- including gateway-proxy paths -- flow through Clerk so the
  // admin bearer token is never injected onto an unauthenticated request. The
  // platform-verified fast-path above covers the pre-authenticated
  // backend-to-backend case.
  return withClerk(request, event);
}

export const config = {
  matcher: [
    "/gateway/:path*",
    "/icons/:path*",
    "/files/:path*",
    "/modules/:path*",
    "/apps/:path*",
    "/api/:path*",
    "/trpc/:path*",
    "/ws",
    "/ws/:path*",
    "/((?!_next|.*\\..*).*)",
  ],
};
