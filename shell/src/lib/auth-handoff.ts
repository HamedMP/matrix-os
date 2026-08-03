import { getConfiguredAppOrigin } from "./public-origin";

const DEFAULT_APP_ORIGIN = "https://app.matrix-os.com";
const T3_CONNECT_PATH = "/?launch=__terminal__&terminal_action=t3-connect";
const T3_CONNECT_QUERY = "?launch=__terminal__&terminal_action=t3-connect";
const VM_PATH_PATTERN = /^\/vm\/[a-z0-9][a-z0-9-]{0,63}$/;

export function resolveShellAuthRedirectPath(redirectUrl: string | undefined): string {
  if (!redirectUrl) return "/";
  try {
    const url = new URL(redirectUrl, "https://app.matrix-os.com");
    if (
      (url.pathname === "/" || VM_PATH_PATTERN.test(url.pathname)) &&
      url.searchParams.size === 2 &&
      url.searchParams.getAll("launch").length === 1 &&
      url.searchParams.get("launch") === "__terminal__" &&
      url.searchParams.getAll("terminal_action").length === 1 &&
      url.searchParams.get("terminal_action") === "t3-connect"
    ) {
      return url.pathname === "/" ? T3_CONNECT_PATH : `${url.pathname}${T3_CONNECT_QUERY}`;
    }
  } catch (error: unknown) {
    console.warn(
      "[auth-handoff] invalid redirect URL",
      error instanceof Error ? error.name : typeof error,
    );
  }
  return "/";
}

export function resolveShellAuthRedirectUrl(
  redirectUrl: string | undefined,
  configuredAppUrl: string | undefined = process.env.NEXT_PUBLIC_MATRIX_APP_URL,
): string {
  const publicOrigin = getConfiguredAppOrigin(configuredAppUrl) ?? DEFAULT_APP_ORIGIN;
  return new URL(resolveShellAuthRedirectPath(redirectUrl), `${publicOrigin}/`).toString();
}
