import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("provisionUser", () => {
  it("records signup telemetry inside an Inngest step", () => {
    const source = readFileSync(join(process.cwd(), "www/src/inngest/provision-user.ts"), "utf8");
    const recordSignup = source.indexOf('step.run("record-signup"');
    const signupEvent = source.indexOf("MATRIX_TELEMETRY_EVENTS.USER_SIGNED_UP");
    const provisionStep = source.indexOf('step.run("provision-container"');

    expect(recordSignup).toBeGreaterThanOrEqual(0);
    expect(signupEvent).toBeGreaterThan(recordSignup);
    expect(signupEvent).toBeLessThan(provisionStep);
  });
});
