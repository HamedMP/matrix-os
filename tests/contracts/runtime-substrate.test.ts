import { describe, expect, it } from "vitest";
import {
  RuntimeCapabilitiesV1Schema,
  RuntimeProfileCapabilityIdSchema,
  RuntimeLimitReasonSchema,
  RuntimeStateSchema,
  RuntimeStateResponseSchema,
  SubstrateKindSchema,
} from "../../packages/contracts/src/index.js";

const CAPABILITY_IDS = [
  "chat.matrix_ai", "chat.coding_harness", "apps.build", "apps.node_runtime",
  "files", "terminal", "code_editor", "channels", "cron", "bots",
  "integrations", "sites.publish",
] as const;

function allCapabilities(state: string): Record<string, { state: string }> {
  return Object.fromEntries(CAPABILITY_IDS.map((id) => [id, { state }]));
}

describe("runtime substrate contract", () => {
  it("names exactly the vps and container substrates", () => {
    expect(SubstrateKindSchema.options).toEqual(["vps", "container"]);
    expect(SubstrateKindSchema.safeParse("hetzner").success).toBe(false);
  });

  it("names the runtime states clients render and the coarse limit reasons", () => {
    expect(RuntimeStateSchema.options).toEqual([
      "ready", "waking", "restoring", "busy", "limit_reached", "failed", "migrating", "waitlisted",
    ]);
    expect(RuntimeLimitReasonSchema.options).toEqual(["ai_allowance", "storage", "compute"]);
  });

  it("lists every capability id from the contract", () => {
    expect(RuntimeProfileCapabilityIdSchema.options).toEqual([...CAPABILITY_IDS]);
  });

  it("accepts a complete version-1 capability set", () => {
    const capabilities = {
      ...allCapabilities("available"),
      terminal: { state: "unsupported", upgradeUnlocks: true },
      "chat.coding_harness": { state: "disabled-by-policy", upgradeUnlocks: true },
      integrations: { state: "setup-required" },
      "sites.publish": { state: "temporarily-unavailable" },
    };
    const parsed = RuntimeCapabilitiesV1Schema.parse({ version: 1, substrate: "container", capabilities });
    expect(parsed.capabilities.terminal).toEqual({ state: "unsupported", upgradeUnlocks: true });
    expect(parsed.capabilities.files).toEqual({ state: "available" });
  });

  it("rejects incomplete, unknown, or malformed capability sets", () => {
    const valid = { version: 1, substrate: "vps", capabilities: allCapabilities("available") };
    const { terminal: _terminal, ...missingTerminal } = valid.capabilities;
    const rejected = [
      { ...valid, version: 2 },
      { ...valid, substrate: "lambda" },
      { ...valid, capabilities: missingTerminal },
      { ...valid, capabilities: { ...valid.capabilities, "shell.root": { state: "available" } } },
      { ...valid, capabilities: { ...valid.capabilities, files: { state: "on" } } },
      { ...valid, capabilities: { ...valid.capabilities, files: { state: "available", plan: "pro" } } },
      { ...valid, plan: "free" },
    ];
    for (const candidate of rejected) {
      expect(RuntimeCapabilitiesV1Schema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);
    }
  });
});

describe("RuntimeStateResponseSchema", () => {
  it("accepts a plain state and a compute limit with its reset time", () => {
    expect(RuntimeStateResponseSchema.parse({ error: "Matrix computer not ready", runtimeState: "waking" }))
      .toEqual({ error: "Matrix computer not ready", runtimeState: "waking" });
    const capped = RuntimeStateResponseSchema.parse({
      error: "Monthly compute limit reached", runtimeState: "limit_reached", limit: "compute", resetsAt: "2026-12-01T00:00:00.000Z",
    });
    expect(capped).toMatchObject({ limit: "compute", resetsAt: "2026-12-01T00:00:00.000Z" });
  });

  it("requires a limit reason exactly when the state is limit_reached, and a reset time only with one", () => {
    const rejected = [
      { runtimeState: "limit_reached" },
      { runtimeState: "waking", limit: "compute" },
      { runtimeState: "waking", resetsAt: "2026-12-01T00:00:00.000Z" },
      { runtimeState: "limit_reached", limit: "compute", resetsAt: "next month" },
      { runtimeState: "limit_reached", limit: "disk" },
      { runtimeState: "asleep" },
      { runtimeState: "ready", error: "x".repeat(201) },
      { runtimeState: "ready", detail: "provider said no" },
    ];
    for (const candidate of rejected) {
      expect(RuntimeStateResponseSchema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);
    }
  });
});
