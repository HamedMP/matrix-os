import { describe, expect, it, vi } from "vitest";
import { createProductionJevInboxRuntime } from "../../packages/gateway/src/jev/inbox-production.js";
import { JEV_MODEL_ID } from "@matrix-os/contracts";

function setup() {
  const evaluate = vi.fn(async () => ({ requestId: "jev_req_fixture" }));
  const db = {
    getUserByClerkId: vi.fn(async () => ({ id: "platform_owner" })),
    listConnectedServices: vi.fn(async () => [{ id: "connection_fixture", user_id: "platform_owner", service: "gmail", status: "active", account_label: "Work", account_email: "me@example.test" }]),
  };
  const runtime = createProductionJevInboxRuntime({
    homePath: "/unused", ownerId: "owner_fixture", fundedOwnerId: "funded_owner_fixture",
    getAgent: vi.fn(async () => null), settings: { getSnapshot: vi.fn(async () => { throw new Error("Hermes must not be consulted"); }) },
    internalBaseUrl: null, db: db as never,
    service: { evaluate } as never,
  });
  return { runtime, db, evaluate };
}

describe("production Jev dependencies for owned Pi Bots", () => {
  it("exports the workflow without loading Hermes credentials or runtime", async () => {
    const { runtime, db } = setup();
    expect(runtime.botWorkflow).toBeDefined();
    const rows = await runtime.botWorkflow.listGmailAccounts("owner_fixture");
    expect(rows[0]?.account_email).toBe("me@example.test");
    expect(db.listConnectedServices).toHaveBeenCalledWith("platform_owner");
    await runtime.close();
  });
  it("delegates evaluations to the configured funded owner, never the caller identity", async () => {
    const { runtime, evaluate } = setup();
    await runtime.botWorkflow.evaluate("owner_fixture", { model: JEV_MODEL_ID } as never);
    expect(evaluate.mock.calls[0]?.[0]).toBe("funded_owner_fixture");
    await expect(runtime.botWorkflow.evaluate("other_owner", {} as never)).rejects.toThrow();
    expect(evaluate).toHaveBeenCalledTimes(1);
    await runtime.close();
  });
  it("fails closed when funded route readers are missing", async () => {
    const { runtime } = setup();
    expect(await runtime.botWorkflow.fundedReady(new AbortController().signal)).toBe(false);
    await runtime.close();
  });
});
