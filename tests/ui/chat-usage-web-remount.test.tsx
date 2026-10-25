// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createChatUsageClient } from "../../packages/ui/src/chat-usage/client.js";
import { WebChatUsageSettings } from "../../shell/src/components/settings/sections/ChatUsageSettings.js";

const state = vi.hoisted(() => ({ userId: "first-owner", sessionId: "first-session", gateway: "https://matrix.example/vm/first",
  runtimeSlot: "primary", requests: [] as Array<{ owner: string; gateway: string; path: string }> }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: state.userId, sessionId: state.sessionId, isLoaded: true }) }));
vi.mock("../../shell/src/lib/self-host-mode", () => ({ isSelfHostedRuntime: () => false }));
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => state.gateway }));
vi.mock("../../shell/src/lib/ai-credit-checkout", () => ({ currentAiCreditRuntimeSlot: () => state.runtimeSlot }));
vi.mock("../../shell/src/lib/chat-usage-transport", () => ({
  // Keep the production policy/summary client and real panel. Only network bytes are substituted.
  createWebChatUsageClient: ({ isIdentityCurrent }: { isIdentityCurrent: () => boolean }) => createChatUsageClient(async input => {
    state.requests.push({ owner: state.userId, gateway: state.gateway, path: input.path });
    if (input.path.endsWith("/policy")) return { enabled: false, sampleRateBps: 1000, modelId: "@cf/meta/classifier",
      recipient: "Cloudflare Workers AI", disclosureVersion: "chat-usage-v1", retentionDays: 30 };
    return { from: "2026-10-18T12:00:00.000Z", to: "2026-10-25T12:00:00.000Z", groupLimit: 100,
      mayBeTruncated: false, classificationIsEstimate: true, buckets: [{
        dimensions: { taskFamily: state.userId === "second-owner" || state.runtimeSlot === "pr-1" ? "writing" : "coding" },
        generations: 1, sampled: 1, classified: 1, inputTokens: 10, outputTokens: null, cachedInputTokens: null,
        costUsd: null, latencyMsMean: null, unknownInputTokenGenerations: 0, unknownOutputTokenGenerations: 1,
        unknownCachedInputTokenGenerations: 1, unknownCostGenerations: 1, unknownLatencyGenerations: 1,
        samplingRateBpsMin: 1000, samplingRateBpsMax: 1000,
      }] };
  }, isIdentityCurrent),
}));

afterEach(() => { cleanup(); state.userId = "first-owner"; state.sessionId = "first-session";
  state.gateway = "https://matrix.example/vm/first"; state.runtimeSlot = "primary"; state.requests.length = 0; });

it("real client and panel load the new owner on the first account-switch attempt", async () => {
  const view = render(<WebChatUsageSettings />); await screen.findByText("coding");
  state.userId = "second-owner"; state.sessionId = "second-session";
  view.rerender(<WebChatUsageSettings />);
  await screen.findByText("writing");
  expect(screen.queryByRole("alert")).toBeNull(); expect(screen.queryByText("coding")).toBeNull();
  expect(state.requests.filter(request => request.owner === "second-owner").map(request => request.path))
    .toEqual(["/api/chat-usage/policy", "/api/chat-usage/summary?groupBy=taskFamily&limit=100"]);
});

it("real client and panel load a newly selected computer before any retry", async () => {
  const view = render(<WebChatUsageSettings />); await screen.findByText("coding");
  state.gateway = "https://matrix.example/vm/second/~runtime/pr-1"; state.runtimeSlot = "pr-1";
  view.rerender(<WebChatUsageSettings />);
  await screen.findByText("writing");
  expect(screen.queryByRole("alert")).toBeNull(); expect(screen.queryByText("coding")).toBeNull();
  expect(state.requests.filter(request => request.gateway.includes("/vm/second/")).map(request => request.path))
    .toEqual(["/api/chat-usage/policy", "/api/chat-usage/summary?groupBy=taskFamily&limit=100"]);
});
