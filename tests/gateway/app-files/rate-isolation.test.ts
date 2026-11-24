import { afterEach, describe, expect, it } from "vitest";
import { createAppFileAdmission } from "../../../packages/gateway/src/app-files/admission";
import { createHarness, errorCode, installApp, type AppFileHarness } from "./helpers";

let harness: AppFileHarness | null = null;
afterEach(async () => { await harness?.cleanup(); harness = null; });

describe("app file rate budget", () => {
  it("keeps one app's exhausted budget from starving another app", async () => {
    harness = await createHarness();
    await installApp(harness.home, { slug: "noisy", permissions: [] });
    for (let index = 0; index < 130; index++) await harness.post({ kind: "files.stat", path: "x" }, "noisy");
    const noisy = await harness.post({ kind: "files.stat", path: "x" }, "noisy");
    expect(noisy.status).toBe(503);
    const docs = await harness.post({ kind: "files.list", dir: "" }, "docs");
    expect(docs.status).toBe(200);
  });

  it("still enforces a global ceiling across many apps", async () => {
    harness = await createHarness();
    const statuses: number[] = [];
    // Unknown identities are refused (403) but still spend the shared ceiling.
    for (let app = 0; app < 6; app++) {
      for (let index = 0; index < 100; index++) statuses.push((await harness.post({ kind: "files.stat", path: "x" }, `app-${app}`)).status);
    }
    expect(statuses.every((status) => status === 403)).toBe(true);
    const response = await harness.post({ kind: "files.list", dir: "" }, "docs");
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("unavailable");
  });
});

describe("app file admission registry", () => {
  it("caps the per-app registry and evicts the least recently used idle app", () => {
    const admission = createAppFileAdmission({ maxTrackedApps: 3, perAppRatePerMinute: 2, globalRatePerMinute: 1000 });
    for (const app of ["a", "b", "c", "d", "e"]) admission.admitApp(app)?.();
    expect(admission.trackedApps()).toBe(3);
  });

  it("never evicts an app with work in flight and refuses a new app instead", () => {
    const admission = createAppFileAdmission({ maxTrackedApps: 2, perAppMaxInFlight: 4 });
    const a = admission.admitApp("a");
    const b = admission.admitApp("b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(admission.admitApp("c")).toBeNull();
    expect(admission.trackedApps()).toBe(2);
    a?.();
    expect(admission.admitApp("c")).not.toBeNull();
    expect(admission.trackedApps()).toBe(2);
  });

  it("bounds each app's concurrent work and releases slots exactly once", () => {
    const admission = createAppFileAdmission({ perAppMaxInFlight: 2 });
    const first = admission.admitApp("a");
    const second = admission.admitApp("a");
    expect(admission.admitApp("a")).toBeNull();
    first?.(); first?.();
    const third = admission.admitApp("a");
    expect(third).not.toBeNull();
    expect(admission.admitApp("a")).toBeNull();
    second?.(); third?.();
  });

  it("resets each window after a minute", () => {
    let now = 0;
    const admission = createAppFileAdmission({ perAppRatePerMinute: 1, now: () => now });
    admission.admitApp("a")?.();
    expect(admission.admitApp("a")).toBeNull();
    now = 60_000;
    expect(admission.admitApp("a")).not.toBeNull();
  });
});
