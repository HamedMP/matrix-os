import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BOT_RUNTIME_ENTRY,
  FIXED_BOT_SYSTEMD_PROPERTIES,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
  materializeBotSystemdProperties,
} from "../../packages/scope-runtime/src/bot-profile.js";
import { FIXED_SYSTEMD_PROPERTIES, SCOPE_RUNTIME_PROFILE_DIGEST } from "../../packages/scope-runtime/src/profile.js";

describe("scope-runtime-bot-v1 profile", () => {
  it("keeps every chat isolation property except the lifetime and the mounted runtime", () => {
    const removed = FIXED_SYSTEMD_PROPERTIES.filter((property) => !FIXED_BOT_SYSTEMD_PROPERTIES.includes(property));
    const added = FIXED_BOT_SYSTEMD_PROPERTIES.filter((property) => !FIXED_SYSTEMD_PROPERTIES.includes(property));
    expect(removed).toEqual([
      "BindReadOnlyPaths=<sdk-directory>:/opt/matrix/scope-sdk/sdk",
      "BindReadOnlyPaths=<native-directory>:/opt/matrix/scope-sdk/native",
      "BindReadOnlyPaths=<worker-file>:/opt/matrix/scope-runtime/worker.mjs",
      "RuntimeMaxSec=90",
    ]);
    expect(added).toEqual([
      "BindReadOnlyPaths=<bot-runtime-directory>:/opt/matrix/scope-sdk/bot-runtime",
      "RuntimeMaxSec=900",
    ]);
    for (const property of ["DynamicUser=yes", "PrivateNetwork=yes", "ProtectHome=yes", "ProtectSystem=strict",
      "CapabilityBoundingSet=", "NoNewPrivileges=yes", "MemoryMax=1073741824", "CPUQuota=200%", "TasksMax=256"]) {
      expect(FIXED_BOT_SYSTEMD_PROPERTIES).toContain(property);
    }
  });

  it("pins its own digest and leaves the shared-chat digest unchanged", () => {
    expect(SCOPE_RUNTIME_BOT_PROFILE_DIGEST).toBe("1dbeca2618e45b0731d5c4b69af74c7df9ce80630fda2c5f32d5b62d4045593d");
    expect(SCOPE_RUNTIME_PROFILE_DIGEST).toBe("9f4e3e2ad9e63cb300854dfca7bc31370d4cbae6d15fab902841b2b50a6443c0");
  });

  it("names the Pi version pinned in the bot-runtime bundle as its harness version", async () => {
    const manifest = JSON.parse(await readFile("packages/bot-runtime/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@earendil-works/pi-agent-core"]).toBe(SCOPE_RUNTIME_BOT_HARNESS_VERSION);
    expect(manifest.dependencies["@earendil-works/pi-ai"]).toBe(SCOPE_RUNTIME_BOT_HARNESS_VERSION);
  });

  it("materializes host paths into the bot-runtime mount and the fixed sockets", () => {
    const properties = materializeBotSystemdProperties({
      scopeRoot: "/var/lib/matrix-scope-runtime/runtimes/aa/root",
      botRuntimeDirectory: "/opt/matrix/app/packages/bot-runtime/dist",
      brokerSocket: "/run/matrix-scope-runtime/broker.sock",
      readinessFile: "/var/lib/matrix-scope-runtime/runtimes/aa/ready",
      commandDirectory: "/var/lib/matrix-scope-runtime/runtimes/aa/command",
    });
    expect(properties).toContain("BindReadOnlyPaths=/opt/matrix/app/packages/bot-runtime/dist:/opt/matrix/scope-sdk/bot-runtime");
    expect(properties).toContain("RootDirectory=/var/lib/matrix-scope-runtime/runtimes/aa/root");
    expect(properties.join("\n")).not.toMatch(/<[a-z-]+>/);
    expect(BOT_RUNTIME_ENTRY).toBe("/opt/matrix/scope-sdk/bot-runtime/bot-worker.mjs");
  });
});
