import { describe, expect, it } from "vitest";
import { createHomeMirrorReadiness } from "../../../packages/gateway/src/sync/home-mirror-readiness.js";

describe("home mirror readiness", () => {
  it("stays disabled when the mirror is not configured", () => {
    const readiness = createHomeMirrorReadiness(false);

    expect(readiness.getStatus()).toEqual({ state: "disabled" });
  });

  it("starts in starting state and becomes ready after startup completes", () => {
    const readiness = createHomeMirrorReadiness(true);

    expect(readiness.getStatus()).toEqual({ state: "starting" });
    readiness.markReady();
    expect(readiness.getStatus()).toEqual({ state: "ready" });
  });

  it("becomes failed without retaining or exposing the startup error", () => {
    const readiness = createHomeMirrorReadiness(true);

    readiness.markFailed();

    expect(readiness.getStatus()).toEqual({ state: "failed" });
    expect(Object.keys(readiness.getStatus())).toEqual(["state"]);
  });
});
