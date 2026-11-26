import { expect, it, vi } from "vitest";
import { createSlackAgentRouteLane } from "../../packages/gateway/src/startup/slack-agent-route-lane.js";
import type { SlackBotPlatform } from "../../packages/gateway/src/startup/slack-platform.js";
import type { SlackAgentChannel } from "@matrix-os/contracts/slack-bridge";
import type { BotIntegrationClient } from "../../packages/gateway/src/bots/integration-client.js";

const ownerId = "user_test", machineId = "a1234567-1234-4123-8123-123456789abc", handle = "tester-dev";
const source: SlackAgentChannel = { ownerId, runtimeId: machineId, teamId: "T123", appId: "A123", channelId: "C456",
  senderId: "U123", name: "review-test", sourceId: "a".repeat(64), installationGeneration: 1 };
const platform: SlackBotPlatform = { handle, runtimeSlot: "dev", machineId, platformUrl: "https://example.test", token: "a".repeat(64),
  devTarget: { ownerId, botId: "bot_12345678", chatId: "chat_12345678", machineId, handle, appId: "A123", teamId: "T123", channelId: "C999", agentRoutes: true } };
const repository = {repositoryId:"123",fullName:"acme/fixture"};
const options = { repository, platform, ownerId, computerId: handle, transact: vi.fn(), isActiveManagedAgent: vi.fn() };

it("exposes no routed worker or discovery on the ordinary pilot, foreign owner or computer", () => {
  for (const changed of [{ ownerId: "user_other" }, { computerId: "other" }, { platform: null },
    { platform: { ...platform, runtimeSlot: "primary" } }, { platform: { ...platform, devTarget: { ...platform.devTarget!, agentRoutes: undefined } } }]) {
    expect(createSlackAgentRouteLane({...options,...changed})).toBeUndefined();
  }
});

it("rechecks only the requested channel, rejects a changed installation and uses only the supplied general GitHub client", async () => {
  const github: Pick<BotIntegrationClient, "call" | "inventory"> = { call: vi.fn(), inventory: vi.fn() };
  const list = vi.fn(async () => [source]);
  const lane = createSlackAgentRouteLane({...options, github, listChannels:list})!;
  expect(lane.worker.github).toBe(github);
  const snapshot = {...source, agentId:"bot_reviewer",chatId:"chat_reviewer",github:{...repository,connectionId:"gh",grantId:"repo",revision:1},kind:"review" as const,routeId:"grant_review",revision:1};
  const signal = new AbortController().signal;
  expect(await lane.worker.verifySource(snapshot,signal)).toBe(true);
  expect(list).toHaveBeenCalledWith(signal, source.channelId);
  list.mockClear();
  expect(await lane.worker.verifySource({...snapshot,github:{...snapshot.github,repositoryId:"999"}},signal)).toBe(false);
  expect(list).not.toHaveBeenCalled();
  expect(await lane.worker.verifySource({...snapshot, installationGeneration:2},signal)).toBe(false);
  expect(createSlackAgentRouteLane({...options,listChannels:list})?.worker.github).toBeUndefined();
});
