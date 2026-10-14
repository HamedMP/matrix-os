// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema, type BotProviderConnection } from "@matrix-os/contracts";
import { YourSubscriptions } from "../../packages/ui/src/agents-providers/YourSubscriptions";
import { projectChatGptPlanSnapshot, projectChatGptPlanAppRoutes } from "../../packages/gateway/src/app-ai/chatgpt-plan-projection";
import { initialProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector";

afterEach(cleanup);
const now = new Date("2026-10-14T12:00:00.000Z");
const peer: BotProviderConnection = {
  id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi",
  availability: "available", accountId: "owner-account", models: [{ id: "gpt-owner", displayName: "Owner GPT" }],
  authorization: { revision: 3, enabled: true, background: false }, coordinatorFunding: "subscription",
};
async function renderPeer(observation?: BotProviderConnection) {
  const base = AiProviderSnapshotV3Schema.parse({ contractVersion: 3, revision: 7, refreshedAt: now.toISOString(),
    accounts: [], accessSources: [], drivers: [], instances: [], models: [],
    active: { providerInstanceId: null, accessSourceId: null, modelId: null } });
  const canonical = projectChatGptPlanSnapshot(base, observation, now);
  const snapshot = await projectProviderSettings({ canonical,
    config: initialProviderSettingsConfiguration(canonical, undefined, now), now, supportedActions: ["start_login"] });
  const refresh = vi.fn();
  render(<YourSubscriptions snapshot={snapshot} capabilities={[]} operationIds={{}} workflowStatus={{}}
    forbidden={false} disabled={false} onOpen={vi.fn()} onRefresh={refresh} />);
  return { canonical, snapshot, refresh, card: screen.getByRole("article", { name: "ChatGPT subscription" }) };
}

it("does not override healthy Provider V3 runtime readiness when browser management transport is absent", async () => {
  const { canonical, snapshot, card } = await renderPeer(peer);
  // Prove the premise through the real V3 -> Settings projection, not a
  // renderer-created 'connected' receipt or a synthetic native client.
  expect(snapshot.projectionOf.revision).toBe(canonical.revision);
  expect(snapshot.accessSources.find(source => source.id === peer.id)?.readiness.state).toBe("ready");
  expect(projectChatGptPlanAppRoutes(canonical, true, +now)[0]?.availability).toBe("available");
  expect(within(card).queryByRole("button", { name: /Continue with ChatGPT|Disconnect ChatGPT|Use this device/ })).toBeNull();
  expect(card.querySelector(".matrix-ap-status-chip")).toHaveAttribute("data-state", "ready");
  expect(within(card).queryByText("Unavailable on this surface")).toBeNull();
});

it("does not fabricate runtime readiness when no subscription peer is observed", async () => {
  const { canonical, snapshot, card } = await renderPeer();
  expect(snapshot.accessSources.find(source => source.id === peer.id)).toBeUndefined();
  expect(projectChatGptPlanAppRoutes(canonical, true, +now).every(route => route.availability === "unavailable")).toBe(true);
  expect(card.querySelector(".matrix-ap-status-chip")).not.toHaveAttribute("data-state", "ready");
  expect(within(card).queryByRole("button", { name: "Continue with ChatGPT" })).toBeNull();
});
