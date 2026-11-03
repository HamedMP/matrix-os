import { createAllowedOriginController } from "../allowed-origins.js";
import { resolveBrowserSetupOwner } from "../browser-lab/setup.js";

/** Customer setup must work before the optional native installer adds host config. */
export function createGatewayAllowedOriginController(env: NodeJS.ProcessEnv) {
  let customerShellOrigin: string | undefined;
  if (env.SHELL_ORIGIN === undefined && resolveBrowserSetupOwner(env)) {
    // Same managed public-app setting/default used by the gateway tunnel. Never
    // infer this trusted origin from the request Host, Origin or forwarded headers.
    try {
      const url = new URL(env.MATRIX_PUBLIC_APP_URL ?? "https://app.matrix-os.com");
      if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) {
        customerShellOrigin = url.origin;
      }
    } catch (error) {
      console.warn("[gateway] Invalid public app origin", error instanceof TypeError ? "invalid_url" : "parse_failed");
    }
  }
  return createAllowedOriginController({
    shellOrigin: env.SHELL_ORIGIN ?? customerShellOrigin,
    proxyOrigin: env.PROXY_ORIGIN,
  });
}
