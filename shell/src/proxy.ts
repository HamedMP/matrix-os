import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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

export default clerkMiddleware(async (auth, request) => {
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
