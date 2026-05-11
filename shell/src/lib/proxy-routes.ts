export function isPublicShellPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/manifest.json" ||
    pathname === "/og.png" ||
    pathname === "/favicon.ico" ||
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/sign-up" ||
    pathname.startsWith("/sign-up/")
  );
}

export function isGatewayProxyPath(pathname: string): boolean {
  return (
    pathname.startsWith("/gateway/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/files/") ||
    pathname.startsWith("/modules/") ||
    pathname.startsWith("/apps/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/")
  );
}
