import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

export default clerkMiddleware(async (auth, request) => {
  const { pathname } = request.nextUrl;

  // Proxy gateway API calls
  if (pathname.startsWith("/gateway/")) {
    const target = pathname.replace("/gateway", "");
    const url = new URL(target + request.nextUrl.search, gatewayUrl);
    return NextResponse.rewrite(url);
  }

  // Proxy module requests
  if (pathname.startsWith("/modules/")) {
    const url = new URL(pathname + request.nextUrl.search, gatewayUrl);
    return NextResponse.rewrite(url);
  }

  // Protect all routes -- unauthenticated users redirect to www sign-in
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
