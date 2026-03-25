import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";
const authToken = process.env.MATRIX_AUTH_TOKEN;
const expectedClerkUserId = process.env.MATRIX_CLERK_USER_ID;

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/health",
  "/manifest.json",
  "/og.png",
  "/favicon.ico",
]);

const isGatewayProxy = createRouteMatcher([
  "/gateway/:path*",
  "/api/:path*",
  "/files/:path*",
  "/modules/:path*",
  "/ws/:path*",
]);

// Clerk handler for authenticated routes
const withClerk = clerkMiddleware(async (auth, request) => {
  const { pathname } = request.nextUrl;

  // Layer 1: Clerk authentication (skip public routes)
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  // Layer 2: Owner verification -- ensure logged-in user owns this instance
  if (expectedClerkUserId) {
    const { userId } = await auth();
    if (userId && userId !== expectedClerkUserId) {
      return new NextResponse("Forbidden: you do not own this instance", {
        status: 403,
      });
    }
  }

  // Proxy gateway API and file requests
  if (isGatewayProxy(request)) {
    const target = pathname.startsWith("/gateway/")
      ? pathname.replace("/gateway", "")
      : pathname;
    const url = new URL(target + request.nextUrl.search, gatewayUrl);

    // Layer 3: Inject bearer token for gateway auth
    const headers = new Headers(request.headers);
    if (authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }

    return NextResponse.rewrite(url, { headers });
  }

  return NextResponse.next();
});

// Paths that bypass Clerk entirely (static cacheable assets).
// Clerk adds Cache-Control: no-store to every response it touches,
// which kills browser caching. These paths rewrite directly to the
// gateway so cache headers (max-age=86400, immutable) are preserved.
function isCacheableAsset(pathname: string): boolean {
  return pathname.startsWith("/files/system/icons/");
}

export default function middleware(
  request: NextRequest,
  event: import("next/server").NextFetchEvent,
) {
  const { pathname } = request.nextUrl;

  // Bypass Clerk for cacheable assets -- rewrite directly to gateway
  if (isCacheableAsset(pathname)) {
    const url = new URL(pathname, gatewayUrl);
    return NextResponse.rewrite(url);
  }

  return withClerk(request, event);
}

export const config = {
  matcher: [
    "/gateway/:path*",
    "/files/:path*",
    "/modules/:path*",
    "/ws/:path*",
    "/(api|trpc)(.*)",
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
