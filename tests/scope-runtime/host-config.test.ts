import { describe, expect, it } from "vitest";

import { resolveScopeRuntimeHostConfig as resolve, resolveScopeRuntimeSourcePaths } from "../../packages/scope-runtime/src/host-config.js";
const namespace = "eng432-stage2";
const base = `/var/lib/matrix-devstack/${namespace}`;
const env = { MATRIX_SCOPE_RUNTIME_NAMESPACE: namespace, MATRIX_SCOPE_RUNTIME_APP_ROOT: `${base}/app`, MATRIX_HOME: `${base}/home` };

describe("scope-runtime host configuration", () => {
  it("preserves every installed default and accepts the existing home override", () => {
    expect(resolve({ env: {} })).toEqual({
      appRoot: "/opt/matrix/app", runtimeDirectory: "/run/matrix-scope-runtime", stateRoot: "/var/lib/matrix-scope-runtime",
      supervisorSocket: "/run/matrix-scope-runtime/supervisor.sock", brokerSocket: "/run/matrix-scope-runtime/broker.sock",
      workerUnitPrefix: "matrix-scope-runtime-", supervisorUnit: "matrix-scope-runtime.service",
    });
    expect(resolveScopeRuntimeSourcePaths(resolve({ env: {} }), "x64")).toMatchObject({
      sdkDirectory: "/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk",
      nativeDirectory: "/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64",
      workerFile: "/opt/matrix/app/packages/scope-runtime/dist/worker.js",
      botRuntimeDirectory: "/opt/matrix/app/packages/bot-runtime/dist",
    });
    expect(resolve({ env: { MATRIX_HOME: "/custom/home" }, homePath: "/custom/home" }).appRoot).toBe("/opt/matrix/app");
  });
  it("derives disjoint units, roots and both sockets from canonical explicit inputs", () => {
    expect(resolve({ env, homePath: `${base}/home` })).toEqual({
      namespace, appRoot: `${base}/app`, runtimeDirectory: `/run/matrix-devstack/${namespace}/scope-runtime`,
      stateRoot: `${base}/scope-runtime`, supervisorSocket: `/run/matrix-devstack/${namespace}/scope-runtime/supervisor.sock`,
      brokerSocket: `/run/matrix-devstack/${namespace}/scope-runtime/broker.sock`,
      workerUnitPrefix: `matrix-devstack-${namespace}-scope-runtime-`, supervisorUnit: `matrix-devstack-${namespace}-scope-runtime.service`,
    });
    expect(resolve({ env: { ...env, MATRIX_HOME: undefined }, homePath: `${base}/home` }).namespace).toBe(namespace);
  });
  it.each(["", " ", "bad ", " Bad", "UPPER", "2bad", "bad-", "a/b", "a\\b", "a*", "a\n", "a\0", "a".repeat(33)])("refuses invalid namespace %j", (value) => {
    expect(() => resolve({ env: { ...env, MATRIX_SCOPE_RUNTIME_NAMESPACE: value } })).toThrow();
  });
  it.each(["a", "a9", "a-b", "a".repeat(32)])("accepts bounded namespace %s", (value) => {
    const root = `/var/lib/matrix-devstack/${value}`;
    expect(resolve({ env: { MATRIX_SCOPE_RUNTIME_NAMESPACE: value, MATRIX_SCOPE_RUNTIME_APP_ROOT: `${root}/app`, MATRIX_HOME: `${root}/home` } }).namespace).toBe(value);
  });
  it.each([
    { MATRIX_SCOPE_RUNTIME_APP_ROOT: `${base}/app` },
    { ...env, MATRIX_SCOPE_RUNTIME_APP_ROOT: undefined },
    { ...env, MATRIX_HOME: undefined },
    { ...env, MATRIX_SCOPE_RUNTIME_APP_ROOT: "/opt/matrix/app" },
    { ...env, MATRIX_HOME: "/home/matrix/home" },
    { ...env, MATRIX_SCOPE_RUNTIME_APP_ROOT: `${base}/home` },
    { ...env, MATRIX_HOME: `${base}/app` },
    { ...env, MATRIX_HOME: `${base}/home/` },
    { ...env, MATRIX_SCOPE_RUNTIME_APP_ROOT: `${base}/other/../app` },
    { ...env, MATRIX_SCOPE_RUNTIME_APP_ROOT: `relative/${namespace}/app` },
    { ...env, MATRIX_HOME: "/var/lib/matrix-devstack/peer/home" },
  ])("fails closed on missing, installed, overlapping or unqualified paths %#", (value) => {
    expect(() => resolve({ env: value })).toThrow();
  });
  it("refuses disagreement between supplied home and environment", () => {
    expect(() => resolve({ env, homePath: "/other/home" })).toThrow();
    expect(() => resolve({ env: { MATRIX_HOME: "/a" }, homePath: "/b" })).toThrow();
  });
  it("resolves worker, Bot, SDK and architecture-specific Linux native packages under the app root", () => {
    const config = resolve({ env });
    for (const architecture of ["x64", "arm64"]) {
      expect(resolveScopeRuntimeSourcePaths(config, architecture)).toEqual({
        sdkDirectory: `${base}/app/node_modules/@anthropic-ai/claude-agent-sdk`,
        nativeDirectory: `${base}/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${architecture}`,
        workerFile: `${base}/app/packages/scope-runtime/dist/worker.js`, botRuntimeDirectory: `${base}/app/packages/bot-runtime/dist`,
      });
    }
    expect(() => resolveScopeRuntimeSourcePaths(config, "ia32")).toThrow("architecture");
  });
});
