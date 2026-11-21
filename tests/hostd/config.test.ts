import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../packages/hostd/src/config.js";

const API = "a".repeat(32);
const INGRESS = "i".repeat(40);
const base = {
  HOSTD_API_TOKEN: API,
  HOSTD_INGRESS_TOKEN: INGRESS,
  HOSTD_TLS_CERT_PATH: "/etc/matrix-hostd/tls/cert.pem",
  HOSTD_TLS_KEY_PATH: "/etc/matrix-hostd/tls/key.pem",
};

describe("hostd config", () => {
  it("reads tokens, TLS paths and production defaults", () => {
    expect(loadConfig(base)).toEqual({
      apiToken: API,
      ingressToken: INGRESS,
      tlsCertPath: "/etc/matrix-hostd/tls/cert.pem",
      tlsKeyPath: "/etc/matrix-hostd/tls/key.pem",
      apiHost: "0.0.0.0",
      apiPort: 8443,
      ingressHost: "0.0.0.0",
      ingressPort: 443,
      stateDir: "/var/lib/matrix-hostd",
      runDir: "/run/matrix-vm",
    });
  });

  it("accepts overrides for ports, hosts and directories", () => {
    const config = loadConfig({
      ...base,
      HOSTD_API_PORT: "9443",
      HOSTD_API_HOST: "10.0.0.5",
      HOSTD_INGRESS_PORT: "8444",
      HOSTD_INGRESS_HOST: "127.0.0.1",
      HOSTD_STATE_DIR: "/srv/hostd",
      HOSTD_RUN_DIR: "/run/vms",
    });
    expect(config).toMatchObject({
      apiPort: 9443,
      apiHost: "10.0.0.5",
      ingressPort: 8444,
      ingressHost: "127.0.0.1",
      stateDir: "/srv/hostd",
      runDir: "/run/vms",
    });
  });

  it.each([
    ["a missing API token", { HOSTD_API_TOKEN: undefined }, "HOSTD_API_TOKEN"],
    ["a short API token", { HOSTD_API_TOKEN: "x".repeat(31) }, "HOSTD_API_TOKEN"],
    ["a missing ingress token", { HOSTD_INGRESS_TOKEN: undefined }, "HOSTD_INGRESS_TOKEN"],
    ["a short ingress token", { HOSTD_INGRESS_TOKEN: "short" }, "HOSTD_INGRESS_TOKEN"],
    ["a missing cert path", { HOSTD_TLS_CERT_PATH: undefined }, "HOSTD_TLS_CERT_PATH"],
    ["a relative key path", { HOSTD_TLS_KEY_PATH: "key.pem" }, "HOSTD_TLS_KEY_PATH"],
    ["a bad port", { HOSTD_API_PORT: "70000" }, "HOSTD_API_PORT"],
    ["a relative state dir", { HOSTD_STATE_DIR: "state" }, "HOSTD_STATE_DIR"],
  ])("fails closed on %s and names only the variable", (_label, patch, key) => {
    let caught: unknown;
    try {
      loadConfig({ ...base, ...patch });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.keys).toEqual([key]);
    expect(error.message).toContain(key);
    expect(error.message).not.toContain(API);
    expect(error.message).not.toContain(INGRESS);
  });

  it("refuses to reuse the API token as the ingress token", () => {
    expect(() => loadConfig({ ...base, HOSTD_INGRESS_TOKEN: API })).toThrow(ConfigError);
  });
});
