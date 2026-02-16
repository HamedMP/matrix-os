import { NextResponse, type NextRequest } from "next/server";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

// Auth is handled by the platform proxy layer (Clerk JWT verification)
// before requests reach this container, so no Clerk middleware needed here.
export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Proxy gateway API and file requests
  if (
    pathname.startsWith("/gateway/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/files/") ||
    pathname.startsWith("/modules/") ||
    pathname.startsWith("/ws")
  ) {
    const target = pathname.startsWith("/gateway/")
      ? pathname.replace("/gateway", "")
      : pathname;
    const url = new URL(target + request.nextUrl.search, gatewayUrl);
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Gateway proxy paths (must match even static-looking extensions like .html)
    "/gateway/:path*",
    "/files/:path*",
    "/modules/:path*",
    "/ws/:path*",
    // API routes
    "/(api|trpc)(.*)",
    // All other non-static paths
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
