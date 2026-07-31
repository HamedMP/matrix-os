const T3_CONNECT_PATH = "/?launch=__terminal__&terminal_action=t3-connect";

export function resolveShellAuthRedirectPath(redirectUrl: string | undefined): string {
  if (!redirectUrl) return "/";
  try {
    const url = new URL(redirectUrl, "https://app.matrix-os.com");
    if (
      url.pathname === "/" &&
      url.searchParams.getAll("launch").length === 1 &&
      url.searchParams.get("launch") === "__terminal__" &&
      url.searchParams.getAll("terminal_action").length === 1 &&
      url.searchParams.get("terminal_action") === "t3-connect"
    ) {
      return T3_CONNECT_PATH;
    }
  } catch (error: unknown) {
    console.warn(
      "[auth-handoff] invalid redirect URL",
      error instanceof Error ? error.name : typeof error,
    );
  }
  return "/";
}
