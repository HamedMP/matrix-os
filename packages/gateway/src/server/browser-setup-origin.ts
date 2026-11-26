import { createAllowedOriginController } from "../allowed-origins.js";
import { resolveBrowserSetupOwner } from "../browser-lab/setup.js";

/**
 * The managed public-app setting/default used by the gateway tunnel. Never
 * inferred from the request Host, Origin or forwarded headers.
 */
function publicAppOrigin(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const url = new URL(env.MATRIX_PUBLIC_APP_URL ?? "https://app.matrix-os.com");
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) {
      return url.origin;
    }
  } catch (error) {
    console.warn("[gateway] Invalid public app origin", error instanceof TypeError ? "invalid_url" : "parse_failed");
  }
  return undefined;
}

/** Customer setup must work before the optional native installer adds host config. */
export function createGatewayAllowedOriginController(env: NodeJS.ProcessEnv) {
  const customerShellOrigin = env.SHELL_ORIGIN === undefined && resolveBrowserSetupOwner(env) ? publicAppOrigin(env) : undefined;
  // Spec 2707: a connected self-hosted computer keeps its own origin (often the tailnet URL)
  // and also accepts the platform app origin it enrolled with, which the platform forwards.
  const platformOrigin = env.MATRIX_SELF_HOSTED === "1" && env.MATRIX_SUBSTRATE === "owned" ? publicAppOrigin(env) : undefined;
  return createAllowedOriginController({
    shellOrigin: env.SHELL_ORIGIN ?? customerShellOrigin,
    proxyOrigin: env.PROXY_ORIGIN,
    platformOrigin,
  });
}
