import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/gateway/")) {
    const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";
    const target = pathname.replace("/gateway", "");
    const url = new URL(target + request.nextUrl.search, gatewayUrl);
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}
