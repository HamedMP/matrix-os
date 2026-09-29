import { describe, expect, it, vi } from "vitest";
import {
  assertMachineFreeJourney,
  assertNonDisclosingDenial,
  classifyAccountOnlyRequest,
  recordAccountOnlyRequests,
} from "./journey-assertions.js";

describe("account-only collaboration journey assertions", () => {
  it("classifies forbidden personal-runtime, billing and provisioning paths at segment boundaries", () => {
    const forbidden = [
      "/api/journey", "/api/journey/retry-provision", "/api/system/info",
      "/api/terminal/workspaces", "/files/a", "/api/auth/ws-token",
      "/api/billing/checkout", "/checkout", "/api/vps/provision",
      "/api/desktop/config", "/api/theme",
      "/vm/preview-owner/api/system/info", "/vm/preview-owner/files/private",
    ];
    for (const path of forbidden) expect(classifyAccountOnlyRequest(path)).toBe("forbidden");
    for (const path of ["/api/collaboration/shared", "/api/organizations", "/api/journeying", "/fileshare", "/shared/chat/123"])
      expect(classifyAccountOnlyRequest(path)).toBe("allowed");
  });

  it("records only same-origin paths without queries or bearer data and fails closed on overflow", () => {
    // One recorder is registered at a time; a later registration replaces it.
    let listener: ((request: { url(): string }) => void) | undefined;
    const page = {
      on: vi.fn((_event: string, callback: (request: { url(): string }) => void) => { listener = callback; }),
      off: vi.fn((_event: string, callback: (request: { url(): string }) => void) => {
        if (listener === callback) listener = undefined;
      }),
    };
    const recorder = recordAccountOnlyRequests(page, "https://app.matrix-os.com", 2);
    for (const url of [
      "https://clerk.example.test/api/journey?token=secret",
      "https://app.matrix-os.com/api/collaboration/shared?token=secret",
      "https://app.matrix-os.com/api/billing/checkout?token=secret",
    ]) listener?.({ url: () => url });
    expect(recorder.paths()).toEqual(["/api/collaboration/shared", "/api/billing/checkout"]);
    expect(() => recorder.assertNoForbiddenRequests()).toThrow(/api\/billing\/checkout/);
    listener?.({ url: () => "https://app.matrix-os.com/api/organizations" });
    expect(() => recorder.assertNoForbiddenRequests()).toThrow(/capacity/);
    recorder.stop();
    expect(listener).toBeUndefined();
  });

  it("requires zero computers and plan_required before account-only journeys", () => {
    expect(() => assertMachineFreeJourney({ computers: [], phase: "plan_required" })).not.toThrow();
    expect(() => assertMachineFreeJourney({ computers: [{ handle: "owner" }], phase: "plan_required" })).toThrow(/computer/);
    expect(() => assertMachineFreeJourney({ computers: [], phase: "ready" })).toThrow(/plan_required/);
  });

  it("requires a generic denial without paths, identities or host details", () => {
    expect(() => assertNonDisclosingDenial(Object.assign(new Error("Collaboration request denied"), { code: "denied" }), ["user_private"]))
      .not.toThrow();
    expect(() => assertNonDisclosingDenial(Object.assign(new Error("/api/private/user_private"), { code: "denied" }), ["user_private"]))
      .toThrow(/disclosed/);
    expect(() => assertNonDisclosingDenial(Object.assign(new Error("Collaboration home is unavailable"), { code: "host_offline" }), []))
      .not.toThrow();
    expect(() => assertNonDisclosingDenial(Object.assign(new Error("Unavailable"), { code: "unavailable" }), []))
      .toThrow(/did not deny/);
  });
});
