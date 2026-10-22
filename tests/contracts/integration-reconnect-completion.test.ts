import { describe, expect, it } from "vitest";
import { hasCompletedIntegrationConnection } from "../../packages/contracts/src/integration-connections.js";

const account = { id: "work", service: "gmail", status: "active", connectedAt: "2026-10-01T10:00:00.000Z" };

describe("integration connection completion", () => {
  it("recognizes an active newly connected account", () => {
    expect(hasCompletedIntegrationConnection([], "gmail", [account])).toBe(true);
  });
  it("recognizes same-ID reauthorization by a strictly advanced connection timestamp", () => {
    expect(hasCompletedIntegrationConnection([account], "gmail", [{ ...account, connectedAt: "2026-10-08T10:00:00.000Z" }])).toBe(true);
  });
  it("recognizes same-ID expired to active recovery", () => {
    expect(hasCompletedIntegrationConnection([{ ...account, status: "expired" }], "gmail", [account])).toBe(true);
  });
  it("does not let a different existing account borrow another account's expired status", () => {
    const personal = { ...account, id: "personal" };
    expect(hasCompletedIntegrationConnection([{ ...account, status: "expired" }, personal], "gmail", [personal])).toBe(false);
  });
  it.each([
    { ...account },
    { ...account, connectedAt: "2026-09-01T10:00:00.000Z" },
    { ...account, connectedAt: "invalid" },
    { ...account, status: "expired", connectedAt: "2026-10-08T10:00:00.000Z" },
    { ...account, id: "slack-account", service: "slack" },
  ])("ignores unchanged, stale, inactive or unrelated account metadata: %j", current => {
    expect(hasCompletedIntegrationConnection([account], "gmail", [current])).toBe(false);
  });
  it("does not count a new account until it becomes active", () => {
    expect(hasCompletedIntegrationConnection([], "gmail", [{ ...account, status: "pending" }])).toBe(false);
  });
});
