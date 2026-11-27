import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTabId } from "../../packages/gateway/src/herdr/refs.js";
import { createHerdrSessionsFromEnv, herdrTerminalLookup, herdrTransportOptions } from "../../packages/gateway/src/herdr/register.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

describe("Herdr sessions gateway switch", () => {
  it("opens the configured user Core without passing Gateway secrets to its shells", () => {
    expect(herdrTransportOptions({
      MATRIX_HERDR: "on", MATRIX_HERDR_CORE_BIN: "/home/matrix/bin/hc",
      HOME: "/home/matrix", PATH: "/usr/bin:/bin", HC_SESSION: "eng495", XDG_RUNTIME_DIR: "/run/user/1000",
      SSH_AUTH_SOCK: "/run/user/1000/ssh.sock", DATABASE_URL: "fixture secret", MATRIX_AUTH_TOKEN: "fixture token",
    })).toEqual({
      bin: "/home/matrix/bin/hc",
      env: { HOME: "/home/matrix", PATH: "/usr/bin:/bin", HC_SESSION: "eng495", XDG_RUNTIME_DIR: "/run/user/1000",
        SSH_AUTH_SOCK: "/run/user/1000/ssh.sock" },
    });
  });
  it("stays off unless MATRIX_HERDR=on", () => {
    expect(createHerdrSessionsFromEnv({})).toBeNull();
    expect(createHerdrSessionsFromEnv({ MATRIX_HERDR: "off" })).toBeNull();
    expect(createHerdrSessionsFromEnv({ MATRIX_HERDR: "1" })).toBeNull();
  });

  it("keeps a shared managed Preview off even when a self-host binary is configured", () => {
    expect(createHerdrSessionsFromEnv({
      MATRIX_PREVIEW_RUNTIME: "true", MATRIX_HERDR: "on", MATRIX_HERDR_CORE_BIN: "/unexpected/binary",
    })).toBeNull();
    expect(createHerdrSessionsFromEnv({ MATRIX_HANDLE: "pv-123-13572468", MATRIX_HERDR: "on" })).toBeNull();
  });

  it("uses MATRIX_HERDR_CORE_BIN and reports a missing binary as not-installed", async () => {
    const exitListeners = process.listenerCount("exit");
    const adapter = createHerdrSessionsFromEnv({ MATRIX_HERDR: "on", MATRIX_HERDR_CORE_BIN: join(tmpdir(), "missing-herdr-core") });
    expect(adapter).not.toBeNull();
    expect(await adapter!.list()).toEqual({ available: false, status: "not-installed", sessions: [] });
    await adapter!.close();
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });
});

describe("Herdr terminal lookup", () => {
  it("names only Herdr terminals the core lists now", async () => {
    const core = createFakeHerdrCore();
    core.add("t1");
    const adapter = createHerdrAdapter({ open: async () => core.connect(), ttlMs: 0 });
    try {
      const lookup = herdrTerminalLookup(adapter);
      const ref = (id: string) => ({ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTabId(id) });
      await adapter.list();
      expect(await lookup.listed(ref("t1"))).toBe(true);
      expect(await lookup.listed(ref("t9"))).toBe(false);
      core.terminals.delete("t1");
      expect(await lookup.listed(ref("t1"))).toBe(false);
    } finally {
      await adapter.close();
    }
  });
});
