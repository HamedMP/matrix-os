import { expect, it } from "vitest";
import { z } from "zod/v4";
import { CanonicalChatRunSchema } from "@matrix-os/contracts";
import { projectChatRunResponse, ChatRunWireVersionSchema, chatRunVersionUrl } from "../../packages/contracts/src/chat-run-wire";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat";

it("keeps old strict runs readable in admission, detail, cancellation and SSE without changing stored data", () => {
  const detail = createCanonicalChatFixture("running").snapshot;
  const run = { ...detail.runs[0]!, runPolicy: { memoryMode: "ordinary", source: "voice", nativeCheckpointPolicy: "disposable" },
    capabilitySnapshot: { ...detail.runs[0]!.capabilitySnapshot, cancellation: "tool", approvalBinding: "argument_digest" } };
  const current = CanonicalChatRunSchema.parse(run);
  const legacyRun = z.object({ ...CanonicalChatRunSchema.shape,
    runPolicy: z.never().optional(), capabilitySnapshot: z.object({ ...CanonicalChatRunSchema.shape.capabilitySnapshot.shape,
      cancellation: z.boolean(), approvalBinding: z.never().optional() }).strict() }).strict();
  const wire = projectChatRunResponse({ run: current, runs: [current], content: { runs: [current] },
    queuedTurns: [{ id: "queued_1", runPolicy: current.runPolicy }], operations: [{ id: "action_1" }], granularity: "tool" }, "0");
  for (const value of [wire.run, wire.runs[0], wire.content.runs[0]]) expect(legacyRun.safeParse(value).success).toBe(true);
  expect(wire.run.capabilitySnapshot.cancellation).toBe(false); // no whole-run stop is promised for tool-only support
  expect(wire).not.toHaveProperty("operations"); expect(wire).not.toHaveProperty("granularity");
  expect(wire.queuedTurns[0]).not.toHaveProperty("runPolicy");
  expect(current.capabilitySnapshot.cancellation).toBe("tool");
  expect(projectChatRunResponse({ run: current }, "1").run).toBe(current);
  expect(projectChatRunResponse({ run: { ...current, capabilitySnapshot: { ...current.capabilitySnapshot, cancellation: "run" } } }, "0").run.capabilitySnapshot.cancellation).toBe(true);
});

it("strips approval digest extensions only at known wire positions and preserves arbitrary user data", () => {
  const digest = "a".repeat(64);
  const wire = projectChatRunResponse({ messages: [{ parts: [{ type: "approval_request", argumentDigest: digest }] }],
    messageDelta: { message: { parts: [{ type: "approval_request", argumentDigest: digest }] } },
    activities: [{ type: "approval.requested", argumentDigest: digest }, { type: "approval.resolved", argumentDigest: digest }],
    arbitrary: { argumentDigest: digest, runPolicy: "USER_DATA" } }, "0");
  expect(wire.messages[0]!.parts[0]).not.toHaveProperty("argumentDigest");
  expect(wire.messageDelta.message.parts[0]).not.toHaveProperty("argumentDigest");
  expect(wire.activities.every(value => !("argumentDigest" in value))).toBe(true);
  expect(wire.arbitrary).toEqual({ argumentDigest: digest, runPolicy: "USER_DATA" });
  expect(ChatRunWireVersionSchema.parse(undefined)).toBe("0");
  expect(ChatRunWireVersionSchema.safeParse("2").success).toBe(false);
  expect(chatRunVersionUrl("/api/chats?limit=20")).toBe("/api/chats?limit=20&runVersion=1");
  expect(chatRunVersionUrl("/api/chats?runVersion=1")).toBe("/api/chats?runVersion=1");
});
