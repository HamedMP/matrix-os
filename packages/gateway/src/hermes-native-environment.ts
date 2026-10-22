import { join } from "node:path";
import { buildAgentRuntimeEnvironment } from "./agent-launcher.js";

const NETWORK_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
] as const;

/** Preserve owner network configuration without inheriting Gateway credentials. */
export function hermesNativeNetworkEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of NETWORK_ENV_KEYS) {
    const value = source[key];
    if (value && value.length <= 4096 && !/[\0\r\n]/.test(value)) environment[key] = value;
  }
  return environment;
}

/** Native Hermes owns its profile/auth files; Gateway credentials must never enter its process. */
export function buildHermesNativeEnvironment(homePath: string, nativeRoot: string): Record<string, string> {
  return {
    ...buildAgentRuntimeEnvironment(homePath),
    ...hermesNativeNetworkEnvironment(process.env),
    HERMES_HOME: join(homePath, ".hermes"),
    HERMES_PYTHON_SRC_ROOT: nativeRoot,
    PYTHONPATH: nativeRoot,
    PYTHONUNBUFFERED: "1",
    LANG: "C.UTF-8",
  };
}
