import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Startup must mount the owner sync routes whenever runtime credentials can
 * be verified, with or without primary sync storage. The live ENG-520 E2E
 * failed because startup built them only under `storageConfig.primary &&
 * platformSecret`: on a preview without primary storage the guest's restore
 * probe fell through to session routing and got 401, so the VM never
 * registered. The route behaviour itself is covered in metal-firstboot.test.ts.
 */
function syncRoutesWiring(source: string): { gate: string; call: string } | null {
  const call = source.indexOf("createConfiguredInternalSyncRoutes({");
  if (call < 0) return null;
  const gateStart = source.lastIndexOf("if (", call);
  const gateEnd = source.indexOf(") {", gateStart);
  return { gate: source.slice(gateStart + 4, gateEnd).trim(), call: source.slice(call, source.indexOf("});", call)) };
}

describe("internal sync startup wiring", () => {
  it("mounts the sync routes on a platform secret alone, passing storage only when configured", () => {
    const wiring = syncRoutesWiring(readFileSync("packages/platform/src/platform-startup.ts", "utf8"));

    expect(wiring).not.toBeNull();
    expect(wiring!.gate).toBe("platformSecret");
    expect(wiring!.call).toContain("r2: coreRepoObjectStore ?? null,");
    expect(wiring!.call).toContain("env: process.env,");
    expect(readFileSync("packages/platform/src/platform-startup.ts", "utf8")).not.toMatch(/createInternalSyncRoutes\(/);
  });

  it("rejects the gate that left previews without sync routes", () => {
    const old = [
      "  if (storageConfig.primary && platformSecret) {",
      "    internalSyncRoutes = createConfiguredInternalSyncRoutes({",
      "      db, r2: coreRepoObjectStore ?? null, env: process.env,",
      "    });",
      "  }",
    ].join("\n");

    expect(syncRoutesWiring(old)?.gate).toBe("storageConfig.primary && platformSecret");
  });
});
