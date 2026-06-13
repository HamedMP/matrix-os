import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJourney,
  journeyGuidance,
  describeProgress,
  type CliJourneyState,
} from "../../src/cli/journey.js";

function state(partial: Partial<CliJourneyState>): CliJourneyState {
  return {
    phase: "plan_required",
    detail: "detail",
    nextAction: { kind: "open_plans" },
    ...partial,
  } as CliJourneyState;
}

describe("cli journeyGuidance", () => {
  it("guides an unknown (null) journey to `mos setup`", () => {
    const g = journeyGuidance(null);
    expect(g.suggestedCommand).toBe("setup");
    expect(g.exitCode).toBe(1);
    expect(g.lines.join(" ")).toMatch(/mos setup/);
  });

  it("plan_required prints the plans URL and suggests setup", () => {
    const g = journeyGuidance(state({ phase: "plan_required", nextAction: { kind: "open_plans", url: "https://app.matrix-os.com/?plans=1" } }));
    expect(g.lines.join("\n")).toContain("https://app.matrix-os.com/?plans=1");
    expect(g.suggestedCommand).toBe("setup");
  });

  it("delayed payment_settling points at support", () => {
    const g = journeyGuidance(state({ phase: "payment_settling", settling: { since: "x", delayed: true } }));
    expect(g.lines.join(" ")).toMatch(/support@matrix-os.com/);
  });

  it("retryable provisioning_failed suggests setup; exhausted points at support", () => {
    expect(journeyGuidance(state({ phase: "provisioning_failed", failure: { retryable: true, attempt: 1 } })).suggestedCommand).toBe("setup");
    const exhausted = journeyGuidance(state({ phase: "provisioning_failed", failure: { retryable: false, attempt: 3 } }));
    expect(exhausted.suggestedCommand).toBeUndefined();
    expect(exhausted.lines.join(" ")).toMatch(/support@matrix-os.com/);
  });

  it("first_run / ready suggest re-running login", () => {
    expect(journeyGuidance(state({ phase: "first_run" })).suggestedCommand).toBe("login");
    expect(journeyGuidance(state({ phase: "ready" })).suggestedCommand).toBe("login");
  });

  it("describeProgress maps the provisioning stage to a human label", () => {
    expect(describeProgress(state({ phase: "provisioning", progress: { stage: "booting", startedAt: "x" } }))).toBe("booting your computer");
  });
});

describe("cli fetchJourney", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the journey state on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ phase: "plan_required", detail: "d", nextAction: { kind: "open_plans" } }), { status: 200 })));
    const j = await fetchJourney("https://api.matrix-os.com", "tok");
    expect(j?.phase).toBe("plan_required");
  });

  it("returns null on a non-200 (e.g. 401) without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    expect(await fetchJourney("https://api.matrix-os.com", "tok")).toBeNull();
  });

  it("returns null when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await fetchJourney("https://api.matrix-os.com", "tok")).toBeNull();
  });
});
