import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function findStepRunRange(source: string, stepName: string): { start: number; end: number } {
  const start = source.indexOf(`step.run("${stepName}"`);
  expect(start).toBeGreaterThanOrEqual(0);

  const openBrace = source.indexOf("{", start);
  expect(openBrace).toBeGreaterThan(start);

  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i };
    }
  }

  throw new Error(`Could not find end of ${stepName} step`);
}

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

  it("keeps PostHog operations scoped to deterministic Inngest steps", () => {
    const source = readFileSync(join(process.cwd(), "www/src/inngest/provision-user.ts"), "utf8");
    const stepRanges = [
      "record-signup",
      "record-provision-started",
      "provision-container",
      "verify-running",
    ].map((stepName) => findStepRunRange(source, stepName));

    const posthogOperations = [
      ...source.matchAll(/getPostHogClient\(\)|posthog\.(?:capture|identify)\(/g),
    ];
    expect(posthogOperations.length).toBeGreaterThan(0);

    for (const operation of posthogOperations) {
      const index = operation.index ?? -1;
      const isInsideStep = stepRanges.some((range) => index > range.start && index < range.end);
      expect(isInsideStep, `${operation[0]} must be inside a step.run callback`).toBe(true);
    }
  });
});
