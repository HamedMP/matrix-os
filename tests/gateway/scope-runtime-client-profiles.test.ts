import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScopeRuntimeCapabilityProfile, ScopeRuntimeResponse } from "../../packages/scope-runtime/src/protocol.js";
import { SCOPE_RUNTIME_BOT_PROFILE, SCOPE_RUNTIME_MANAGED_PI_PROFILE, SCOPE_RUNTIME_PROFILE } from "../../packages/scope-runtime/src/supervisor.js";
import { createScopeRuntimeClient } from "../../packages/gateway/src/collaboration/scope-runtime-client.js";
import { SHARED_AI_PROFILE_CATALOG } from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";
import { BOT_SCOPE_RUNTIME_PROFILE_CATALOG } from "../../packages/gateway/src/bots/scope-runtime-profile.js";
import { MANAGED_PI_SCOPE_RUNTIME_PROFILE_CATALOG } from "../../packages/gateway/src/chat/managed-pi-profile.js";

const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const catalog = { ...SHARED_AI_PROFILE_CATALOG, ...BOT_SCOPE_RUNTIME_PROFILE_CATALOG, ...MANAGED_PI_SCOPE_RUNTIME_PROFILE_CATALOG };
const chat = { ...SCOPE_RUNTIME_PROFILE, executionGeneration: "5" } as ScopeRuntimeCapabilityProfile;
const bot = { ...SCOPE_RUNTIME_BOT_PROFILE, executionGeneration: "5" } as ScopeRuntimeCapabilityProfile;
const managed = { ...SCOPE_RUNTIME_MANAGED_PI_PROFILE, executionGeneration: "5" } as ScopeRuntimeCapabilityProfile;
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function supervisor(response: () => Omit<Extract<ScopeRuntimeResponse, { type: "capability.result"; ok: true }>, "requestId">) {
  const root = await mkdtemp(join(tmpdir(), "scope-client-profiles-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "supervisor.sock");
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.once("end", () => {
      const { requestId } = JSON.parse(input) as { requestId: string };
      socket.end(`${JSON.stringify({ ...response(), requestId })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const client = createScopeRuntimeClient({ socketPath, profileCatalog: catalog, createRequestId: () => REQUEST_ID });
  cleanup.push(() => client.close());
  return client;
}

const base = { version: 1 as const, type: "capability.result" as const, ok: true as const, supervisorVersion: "1.0.0", profile: chat };

describe("scope runtime client profiles", () => {
  it("pins managed Chat independently from recipe Bot and rejects old/digest-drifted supervisors", async () => {
    const client = await supervisor(() => ({ ...base, profiles: [chat, bot, managed] }));
    await client.refreshCapability();
    expect(client.profileCapability(managed.profileId)).toMatchObject({ available: true, profileId: managed.profileId });
    const drifted = await supervisor(() => ({ ...base, profiles: [chat, bot, { ...managed, profileDigest: bot.profileDigest }] }));
    await drifted.refreshCapability();
    expect(drifted.profileCapability(managed.profileId)).toEqual({ available: false, reason: "unsupported_profile" });
    expect(drifted.profileCapability(bot.profileId)).toMatchObject({ available: true });
    const old = await supervisor(() => ({ ...base, profiles: [chat, bot] }));
    await old.refreshCapability();
    expect(old.profileCapability(managed.profileId)).toEqual({ available: false, reason: "unsupported_profile" });
  });
  it("accepts each advertised profile with its exact pinned digest", async () => {
    const client = await supervisor(() => ({ ...base, profiles: [chat, bot] }));
    await expect(client.refreshCapability()).resolves.toMatchObject({ available: true, profileId: "scope-runtime-chat-v1" });
    expect(client.profileCapability("scope-runtime-bot-v1")).toMatchObject({
      available: true,
      profileId: "scope-runtime-bot-v1",
      executionGeneration: "5",
      supportedAdapters: [{ adapterId: "matrix-bot", harnessVersion: "0.86.1", workloads: ["bot_agent"] }],
      sandbox: { workloads: ["bot_agent"] },
    });
    expect(client.profileCapability("scope-runtime-chat-v1")).toMatchObject({ available: true });
  });

  it("fails closed per profile: a bot digest mismatch leaves shared Chat available", async () => {
    const drifted = { ...bot, profileDigest: "0".repeat(64) };
    const client = await supervisor(() => ({ ...base, profiles: [chat, drifted] }));
    await expect(client.refreshCapability()).resolves.toMatchObject({ available: true });
    expect(client.profileCapability("scope-runtime-bot-v1")).toEqual({ available: false, reason: "unsupported_profile" });

    const wrongAdapter = await supervisor(() => ({ ...base, profiles: [chat, { ...bot, adapters: [{ adapterId: "matrix-bot", harnessVersion: "0.87.0", workloads: ["bot_agent"] }] }] }));
    await wrongAdapter.refreshCapability();
    expect(wrongAdapter.profileCapability("scope-runtime-bot-v1")).toEqual({ available: false, reason: "unsupported_profile" });
  });

  it("treats a supervisor that predates the catalog as offering no bot profile", async () => {
    const client = await supervisor(() => base);
    await expect(client.refreshCapability()).resolves.toMatchObject({ available: true });
    expect(client.profileCapability("scope-runtime-bot-v1")).toEqual({ available: false, reason: "unsupported_profile" });
    expect(client.profileCapability("scope-runtime-chat-v1")).toMatchObject({ available: true });
    expect(client.profileCapability("scope-runtime-unknown-v1")).toEqual({ available: false, reason: "unsupported_profile" });
  });
});
