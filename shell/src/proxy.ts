import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";
const authToken = process.env.MATRIX_AUTH_TOKEN;
const expectedClerkUserId = process.env.MATRIX_CLERK_USER_ID;
const platformSecret = process.env.PLATFORM_SECRET;

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

  // Platform already verified the Clerk session -- skip re-verification
  const platformVerified = request.headers.get("x-platform-verified");
  if (platformSecret && platformVerified === platformSecret) {
    // Proxy gateway API and file requests
    if (isGatewayProxy(request)) {
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
    return NextResponse.next();
  }

  // Layer 1: Clerk authentication (skip public routes)
  if (!isPublicRoute(request)) {
    const { userId } = await auth();
    if (!userId) {
      const signInUrl = new URL("/sign-in", request.url);
      signInUrl.searchParams.set("redirect_url", request.url);
      return NextResponse.redirect(signInUrl);
    }
  }

  // Layer 2: Owner verification -- fail closed when configured (skip public routes)
  if (expectedClerkUserId && !isPublicRoute(request)) {
    const { userId } = await auth();
    if (userId !== expectedClerkUserId) {
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

    return NextResponse.rewrite(url, { request: { headers } });
  }

  return NextResponse.next();
});

export default function middleware(
  request: NextRequest,
  event: import("next/server").NextFetchEvent,
) {
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
