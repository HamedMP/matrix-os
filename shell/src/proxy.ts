import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

  if (pathname.startsWith("/gateway/")) {
    const target = pathname.replace("/gateway", "");
    const url = new URL(target + request.nextUrl.search, gatewayUrl);
    return NextResponse.rewrite(url);
  }

  if (pathname.startsWith("/modules/")) {
    const url = new URL(pathname + request.nextUrl.search, gatewayUrl);
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}
