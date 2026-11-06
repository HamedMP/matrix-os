import { expect, it, vi } from "vitest";
import { ChatGptPlanPeerRequestSchema } from "@matrix-os/contracts";
import { fixture, request, session } from "./chatgpt-plan-roundtrip-support";

it.each([true, false])("only accepts a routine occurrence after explicit protocol negotiation (%s) without writing broad background permission", async negotiated => {
  const x = await fixture("primary", negotiated);
  try {
    await x.signedIn();
    const before = await x.service.status(session), saved = await x.vault.load("owner");
    const run = request("00000000-0000-4000-8000-000000000045", before.account!.id, before.grant.revision);
    if (run.action !== "infer") throw new Error("Expected inference request");
    run.requestClass = "background";
    run.approvedRoutine = { ownerId: "owner", botId: "bot_fixture", chatId: "chat_fixture", taskId: "task_fixture",
      runId: run.runId, routineId: "rt_fixture", fireId: "fire_fixture", approvalId: "in_fixture" };
    x.queue([run, run]);
    await vi.waitFor(() => expect(x.replies).toHaveLength(1));
    expect(x.replies[0]?.ok).toBe(negotiated);
    expect(x.providerBodies).toHaveLength(negotiated ? 1 : 0);
    expect((await x.service.status(session)).grant).toEqual(before.grant);
    expect(before.grant.background).toBe(false);
    expect(await x.vault.load("owner")).toEqual(saved);
  } finally { await x.cleanup(); }
});

it("keeps interactive Chat working against an older Gateway with no routine-capability echo", async () => {
  const x = await fixture("primary", false);
  try {
    await x.signedIn(); const before = await x.service.status(session);
    x.queue([request("00000000-0000-4000-8000-000000000046", before.account!.id, before.grant.revision)]);
    await vi.waitFor(() => expect(x.replies[0]?.ok).toBe(true));
    expect(x.providerBodies).toHaveLength(1);
  } finally { await x.cleanup(); }
});

it.each(["owner", "computer", "account", "revision", "run", "interactive-marker"] as const)("does not let an approved-routine marker bypass %s binding", async changed => {
  const x = await fixture("primary", true);
  try {
    await x.signedIn(); const before = await x.service.status(session);
    const run = request("00000000-0000-4000-8000-000000000047", before.account!.id, before.grant.revision);
    if (run.action !== "infer") throw new Error("Expected inference");
    run.requestClass = changed === "interactive-marker" ? "interactive" : "background";
    run.approvedRoutine = {ownerId: changed === "owner" ? "foreign" : "owner", botId: "bot_fixture", chatId: "chat_fixture", taskId: "task_fixture",
      runId: changed === "run" ? "foreign-run" : run.runId, routineId: "rt_fixture", fireId: "fire_fixture", approvalId: "in_fixture"};
    if (changed === "computer") run.computerId = "foreign";
    if (changed === "account") run.accountId = "foreign";
    if (changed === "revision") run.grantRevision++;
    if (changed === "run" || changed === "interactive-marker") {
      expect(ChatGptPlanPeerRequestSchema.safeParse(run).success).toBe(false);
    } else {
      x.queue([run]);
      await vi.waitFor(() => expect(x.replies[0]?.ok).toBe(false));
    }
    expect(x.providerBodies).toHaveLength(0);
  } finally { await x.cleanup(); }
});

it("does not restore old approved-routine authority after a same-off revocation fails to persist", async () => {
  const x = await fixture("primary", true);
  try {
    await x.signedIn(); const before = await x.service.status(session);
    const saved = vi.spyOn(x.vault, "save").mockRejectedValue(new Error("Fixture persistence failure"));
    await expect(x.service.setGrant({...session, enabled: true, background: false, accountId: before.account!.id, baseRevision: before.grant.revision})).rejects.toThrow();
    const status = await x.service.status(session);
    expect(status.grantSaveUnconfirmed).toBe(true);
    expect(status.bridgeConnected).toBe(false);
    expect(status.grant.revision).toBe(before.grant.revision + 1);
    saved.mockRestore();
  } finally { await x.cleanup(); }
});

it("aborts an in-flight default routine on revocation and rejects its old marker revision", async () => {
  const x = await fixture("primary", true); let release = () => {};
  try {
    await x.signedIn(); const before = await x.service.status(session);
    release = x.holdResponse();
    const active = request("00000000-0000-4000-8000-000000000048", before.account!.id, before.grant.revision);
    if (active.action !== "infer") throw new Error("Expected inference");
    active.requestClass = "background";
    active.approvedRoutine = {ownerId: "owner", botId: "bot_fixture", chatId: "chat_fixture", taskId: "task_fixture", runId: active.runId,
      routineId: "rt_fixture", fireId: "fire_fixture", approvalId: "in_fixture"};
    x.queue([active]);
    await vi.waitFor(() => expect(x.providerBodies).toHaveLength(1));
    const stopped = await x.service.setGrant({...session, enabled: true, background: false, accountId: before.account!.id, baseRevision: before.grant.revision});
    expect(x.responseAborted).toBe(true);
    expect(stopped.grant).toMatchObject({background: false, revision: before.grant.revision + 1});
    release();
    const stale = request("00000000-0000-4000-8000-000000000049", before.account!.id, before.grant.revision);
    if (stale.action !== "infer") throw new Error("Expected inference");
    stale.requestClass = "background"; stale.approvedRoutine = active.approvedRoutine;
    x.queue([stale]);
    await vi.waitFor(() => expect(x.replies.find(reply => reply.id === stale.id)?.ok).toBe(false));
    expect(x.providerBodies).toHaveLength(1);
  } finally { release(); await x.cleanup(); }
});
