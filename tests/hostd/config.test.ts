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
      poolMaxDataPercent: 85,
      poolMaxMetadataPercent: 80,
      poolQueryTimeoutMs: 5_000,
    });
  });

  it("reads the thin pool query timeout within 100..60000 ms", () => {
    expect(loadConfig({ ...base, HOSTD_POOL_QUERY_TIMEOUT_MS: "2500" }).poolQueryTimeoutMs).toBe(2_500);
    expect(() => loadConfig({ ...base, HOSTD_POOL_QUERY_TIMEOUT_MS: "50" })).toThrow(/HOSTD_POOL_QUERY_TIMEOUT_MS/);
    expect(() => loadConfig({ ...base, HOSTD_POOL_QUERY_TIMEOUT_MS: "60001" })).toThrow(/HOSTD_POOL_QUERY_TIMEOUT_MS/);
  });

  it("reads thin pool admission thresholds and refuses ones outside 1..100", () => {
    expect(loadConfig({ ...base, HOSTD_POOL_MAX_DATA_PERCENT: "70", HOSTD_POOL_MAX_METADATA_PERCENT: "60.5" })).toMatchObject({
      poolMaxDataPercent: 70,
      poolMaxMetadataPercent: 60.5,
    });
    expect(() => loadConfig({ ...base, HOSTD_POOL_MAX_DATA_PERCENT: "101" })).toThrow(/HOSTD_POOL_MAX_DATA_PERCENT/);
    expect(() => loadConfig({ ...base, HOSTD_POOL_MAX_METADATA_PERCENT: "0" })).toThrow(/HOSTD_POOL_MAX_METADATA_PERCENT/);
  });

  it("accepts overrides for ports and hosts with the systemd VM directories", () => {
    const config = loadConfig({
      ...base,
      HOSTD_API_PORT: "9443",
      HOSTD_API_HOST: "10.0.0.5",
      HOSTD_INGRESS_PORT: "8444",
      HOSTD_INGRESS_HOST: "127.0.0.1",
      HOSTD_STATE_DIR: "/var/lib/matrix-hostd",
      HOSTD_RUN_DIR: "/run/matrix-vm",
    });
    expect(config).toMatchObject({
      apiPort: 9443,
      apiHost: "10.0.0.5",
      ingressPort: 8444,
      ingressHost: "127.0.0.1",
      stateDir: "/var/lib/matrix-hostd",
      runDir: "/run/matrix-vm",
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
    ["a state dir outside the systemd VM layout", { HOSTD_STATE_DIR: "/srv/hostd" }, "HOSTD_STATE_DIR"],
    ["a run dir outside the systemd VM layout", { HOSTD_RUN_DIR: "/run/vms" }, "HOSTD_RUN_DIR"],
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
