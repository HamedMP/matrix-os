import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BOT_RUNTIME_ENTRY,
  FIXED_BOT_SYSTEMD_PROPERTIES,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_VERSION,
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION,
  SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST,
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
      "RuntimeMaxSec=infinity",
      "BindsTo=<supervisor-unit>",
      "After=<supervisor-unit>",
    ]);
    for (const property of ["DynamicUser=yes", "PrivateNetwork=yes", "ProtectHome=yes", "ProtectSystem=strict",
      "CapabilityBoundingSet=", "NoNewPrivileges=yes", "MemoryMax=1073741824", "CPUQuota=200%", "TasksMax=256"]) {
      expect(FIXED_BOT_SYSTEMD_PROPERTIES).toContain(property);
    }
  });

  it("pins its own digest and includes the command IPC policy in all profile identities", () => {
    expect(SCOPE_RUNTIME_BOT_PROFILE_VERSION).toBe(4);
    expect(SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION).toBe(4);
    expect(SCOPE_RUNTIME_BOT_PROFILE_DIGEST).toBe("c25104c7336269228a52757432b722c5da88104e1b5c25bc2bc3dd17cc3fb8d3");
    expect(SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST).toBe("fba0378f5eb40b884d65bb84b01a7a5feb76c22f02b691563db0be9eb1a59825");
    expect(SCOPE_RUNTIME_PROFILE_DIGEST).toBe("df22ff5eefdf6a4c56415f8164749f893feee3b6c6ad5acaf20eba27bde83769");
  });

  it("materializes only derived supervisor dependencies and changes no other properties", () => {
    const paths = { scopeRoot: "/test/root", botRuntimeDirectory: "/test/bot", brokerSocket: "/test/broker.sock",
      readinessFile: "/test/ready", commandDirectory: "/test/command" };
    const legacy = materializeBotSystemdProperties(paths);
    const candidate = materializeBotSystemdProperties(paths, { namespace: "eng432-stage2" });
    expect(candidate.filter((entry) => /^(BindsTo|After)=/.test(entry))).toEqual([
      "BindsTo=matrix-devstack-eng432-stage2-scope-runtime.service", "After=matrix-devstack-eng432-stage2-scope-runtime.service",
    ]);
    expect(candidate.filter((entry) => !/^(BindsTo|After)=/.test(entry)))
      .toEqual(legacy.filter((entry) => !/^(BindsTo|After)=/.test(entry)));
    expect(() => materializeBotSystemdProperties(paths, { namespace: "bad\nAfter=foreign" })).toThrow();
  });

  it("names the Pi version pinned in the bot-runtime bundle as its harness version", async () => {
    const manifest = JSON.parse(await readFile("packages/bot-runtime/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@earendil-works/pi-agent-core"]).toBe(SCOPE_RUNTIME_BOT_HARNESS_VERSION);
    expect(manifest.dependencies["@earendil-works/pi-ai"]).toBe(SCOPE_RUNTIME_BOT_HARNESS_VERSION);
  });

  it("ships Pi SDK 1.0 with exact release exceptions and matching transitive pins", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8")) as {
      packageManager: string; pnpm: { overrides: Record<string, string> };
    };
    const workspace = await readFile("pnpm-workspace.yaml", "utf8");
    expect(SCOPE_RUNTIME_BOT_HARNESS_VERSION).toBe("1.0.0");
    expect(root.packageManager).toBe("pnpm@10.33.4");
    expect(workspace).toMatch(/^minimumReleaseAge: 10080$/m);
    for (const name of ["pi-agent-core", "pi-ai", "pi-telemetry"]) {
      expect(workspace).toContain(`- "@earendil-works/${name}@1.0.0"`);
    }
    const piExceptions = workspace.split("\n").filter((line) => /^\s*- .*@earendil-works\//.test(line));
    expect(piExceptions.every((line) => /@1\.0\.0"$/.test(line))).toBe(true);
    for (const name of ["pi-ai", "chord", "pi-telemetry"]) {
      expect(root.pnpm.overrides[`@earendil-works/${name}`]).toBe("1.0.0");
    }
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
    expect(properties).toContain("BindsTo=matrix-scope-runtime.service");
    expect(properties).toContain("After=matrix-scope-runtime.service");
    expect(properties.join("\n")).not.toMatch(/<[a-z-]+>/);
    expect(BOT_RUNTIME_ENTRY).toBe("/opt/matrix/scope-sdk/bot-runtime/bot-worker.mjs");
  });
});
