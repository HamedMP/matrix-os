import { afterEach, expect, it, vi } from "vitest";
import { buildHermesNativeEnvironment, hermesNativeNetworkEnvironment } from "../../packages/gateway/src/hermes-native-environment.js";

afterEach(() => vi.unstubAllEnvs());
it("retains bounded proxy and certificate settings while excluding Gateway credentials", () => {
  const network = { HTTP_PROXY: "http://proxy.example:8080", HTTPS_PROXY: "http://proxy.example:8080", ALL_PROXY: "socks5://proxy.example:1080",
    NO_PROXY: "localhost,127.0.0.1", http_proxy: "http://proxy.example:8080", https_proxy: "http://proxy.example:8080",
    all_proxy: "socks5://proxy.example:1080", no_proxy: "localhost,127.0.0.1", SSL_CERT_FILE: "/etc/ssl/owner.pem",
    SSL_CERT_DIR: "/etc/ssl/certs", REQUESTS_CA_BUNDLE: "/etc/ssl/owner.pem", CURL_CA_BUNDLE: "/etc/ssl/owner.pem" };
  for (const [key, value] of Object.entries(network)) vi.stubEnv(key, value);
  vi.stubEnv("MATRIX_PLATFORM_API_KEY", "gateway-secret"); vi.stubEnv("ANTHROPIC_API_KEY", "gateway-provider-secret");
  const environment = buildHermesNativeEnvironment("/home/matrix/home", "/home/matrix/home/.hermes/hermes-agent");
  expect(environment).toMatchObject(network);
  expect(environment).not.toHaveProperty("MATRIX_PLATFORM_API_KEY"); expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
});
it.each(["", "a".repeat(4097), "proxy\nprivate", "proxy\u0000private"])("rejects empty, oversized and malformed network settings", value => {
  // Environment setters may truncate NUL at the OS/runtime boundary. Exercise
  // the raw validator directly instead of asserting a value the runtime lost.
  expect(hermesNativeNetworkEnvironment({ HTTPS_PROXY: value })).not.toHaveProperty("HTTPS_PROXY");
});
