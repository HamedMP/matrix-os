import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getPrimaryEmail,
  getProvisionHandle,
  getProvisionHandleCandidates,
} from "../../www/src/inngest/provision-user-handle";

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
  it("derives valid platform handles and primary emails from Clerk user payloads", () => {
    const user = {
      id: "user_2abcDEF",
      username: null,
      primary_email_address_id: "email_primary",
      email_addresses: [
        { id: "email_secondary", email_address: "other@example.com" },
        { id: "email_primary", email_address: "Neo.User@example.com" },
      ],
    };

    expect(getPrimaryEmail(user)).toBe("Neo.User@example.com");
    expect(getProvisionHandle(user)).toBe("neo-user");
    expect(getProvisionHandleCandidates(user)).toEqual(["neo-user", "u-user-2abcdef"]);
    expect(getProvisionHandle({ id: "user_2abcDEF", username: null })).toBe("u-user-2abcdef");
    expect(getProvisionHandle(user, "staging-")).toBe("staging-neo-user");
  });

  it("records signup telemetry inside an Inngest step", () => {
    const source = readFileSync(join(process.cwd(), "www/src/inngest/provision-user.ts"), "utf8");
    const recordSignup = source.indexOf('step.run("record-signup"');
    const signupEvent = source.indexOf("MATRIX_TELEMETRY_EVENTS.USER_SIGNED_UP");
    const syncStep = source.indexOf('step.run("sync-platform-user"');

    expect(recordSignup).toBeGreaterThanOrEqual(0);
    expect(signupEvent).toBeGreaterThan(recordSignup);
    expect(signupEvent).toBeLessThan(syncStep);
  });

  it("keeps PostHog operations scoped to deterministic Inngest steps", () => {
    const source = readFileSync(join(process.cwd(), "www/src/inngest/provision-user.ts"), "utf8");
    const stepRanges = [
      "record-signup",
      "sync-platform-user",
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

  it("syncs signup users without provisioning a runtime", () => {
    const source = readFileSync(join(process.cwd(), "www/src/inngest/provision-user.ts"), "utf8");

    expect(source).toContain('id: "provision-matrix-os"');
    expect(source).toContain('`${PLATFORM_API_URL}/users/sync`');
    expect(source).toContain("for (const candidateHandle of handleCandidates)");
    expect(source).toContain("res.status === 409");
    expect(source).toContain("NonRetriableError");
    expect(source).not.toContain("/containers/provision");
    expect(source).not.toContain("verify-running");
    expect(source).not.toContain("wait-for-boot");
  });
});
