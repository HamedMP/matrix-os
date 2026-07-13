import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadKernelConfigFile,
  resolveKernelConfigFileAsync,
  tryCreateBrowserServer,
} from "../../packages/kernel/src/options.js";

const browserServerMocks = vi.hoisted(() => ({
  createBrowserMcpServer: vi.fn((config: unknown) => ({
    name: "matrix-os-browser",
    type: "sdk",
    config,
  })),
}));

vi.mock("@matrix-os/mcp-browser/server", () => ({
  createBrowserMcpServer: browserServerMocks.createBrowserMcpServer,
}));

describe("kernel options", () => {
  it("loads the browser MCP server through ESM import", async () => {
    const server = await tryCreateBrowserServer("/home/matrix", {
      headless: true,
      timeout: 30000,
      idleTimeout: 300000,
      defaultProfile: "default",
    });

    expect(server).toEqual({
      name: "matrix-os-browser",
      type: "sdk",
      config: {
        homePath: "/home/matrix",
        headless: true,
        timeout: 30000,
        idleTimeout: 300000,
        defaultProfile: "default",
      },
    });
    expect(browserServerMocks.createBrowserMcpServer).toHaveBeenCalledTimes(1);
  });
});

describe("loadKernelConfigFile", () => {
  let homePath: string;
  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "kernel-cfg-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });
  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown) {
    writeFileSync(join(homePath, "system", "config.json"), JSON.stringify(obj));
  }

  it("returns empty when config.json is missing", () => {
    expect(loadKernelConfigFile(homePath)).toEqual({});
  });

  it("reads a valid model + effort from the kernel section", () => {
    writeConfig({ kernel: { model: "claude-sonnet-4-5", effort: "high" } });
    expect(loadKernelConfigFile(homePath)).toEqual({ model: "claude-sonnet-4-5", effort: "high" });
  });

  it("ignores an invalid effort value", () => {
    writeConfig({ kernel: { model: "claude-opus-4-6", effort: "ludicrous" } });
    expect(loadKernelConfigFile(homePath)).toEqual({ model: "claude-opus-4-6" });
  });

  it("ignores an empty/non-string model", () => {
    writeConfig({ kernel: { model: "", effort: "max" } });
    expect(loadKernelConfigFile(homePath)).toEqual({ effort: "max" });
  });

  it("ignores path-like and oversized model values", () => {
    writeConfig({ kernel: { model: "/opt/matrix/private", effort: "high" } });
    expect(loadKernelConfigFile(homePath)).toEqual({ effort: "high" });

    writeConfig({ kernel: { model: `claude-${"x".repeat(80)}`, effort: "low" } });
    expect(loadKernelConfigFile(homePath)).toEqual({ effort: "low" });
  });

  it("returns empty when there is no kernel section", () => {
    writeConfig({ channels: { telegram: { enabled: true } } });
    expect(loadKernelConfigFile(homePath)).toEqual({});
  });

  it("does not throw on malformed JSON", () => {
    writeFileSync(join(homePath, "system", "config.json"), "{not json");
    expect(loadKernelConfigFile(homePath)).toEqual({});
  });

  it("resolves kernel config asynchronously with the runtime defaults", async () => {
    writeConfig({ kernel: { model: "claude-sonnet-4-5", effort: "medium" } });
    await expect(resolveKernelConfigFileAsync(homePath)).resolves.toEqual({
      model: "claude-sonnet-4-5",
      effort: "medium",
    });

    writeFileSync(join(homePath, "system", "config.json"), "{not json");
    await expect(resolveKernelConfigFileAsync(homePath)).resolves.toEqual({
      model: "claude-opus-4-6",
      effort: "high",
    });
  });

  it("bounds kernel config reads consistently across sync and async loaders", async () => {
    writeConfig({
      kernel: { model: "claude-sonnet-4-5", effort: "medium" },
      padding: "x".repeat(300 * 1024),
    });

    expect(loadKernelConfigFile(homePath)).toEqual({});
    await expect(resolveKernelConfigFileAsync(homePath)).resolves.toEqual({
      model: "claude-opus-4-6",
      effort: "high",
    });
  });
});
