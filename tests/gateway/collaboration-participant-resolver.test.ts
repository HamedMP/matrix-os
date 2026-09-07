import { describe, expect, it, vi } from "vitest";
import {
  CollaborationParticipantResolver,
  CollaborationParticipantResolverError,
} from "../../packages/gateway/src/collaboration/participant-resolver.js";

describe("CollaborationParticipantResolver", () => {
  it("returns a validated platform label and caches it", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ actorId: "user_editor", displayName: "Editor Person" }));
    });
    const resolver = new CollaborationParticipantResolver({
      platformBaseUrl: "https://platform.internal",
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      serviceToken: "s".repeat(32),
      fetchImpl,
    });
    await expect(resolver.resolve("user_editor")).resolves.toMatchObject({ displayName: "Editor Person" });
    await expect(resolver.resolve("user_editor")).resolves.toMatchObject({ displayName: "Editor Person" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects mismatched and oversized identity projections generically", async () => {
    const responses = [
      new Response(JSON.stringify({ actorId: "user_other", displayName: "Wrong" })),
      new Response("x".repeat(8_193)),
    ];
    const resolver = new CollaborationParticipantResolver({
      platformBaseUrl: "https://platform.internal",
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      serviceToken: "s".repeat(32),
      fetchImpl: async () => responses.shift()!,
    });
    for (const actorId of ["user_editor", "user_viewer"]) {
      await expect(resolver.resolve(actorId)).rejects.toBeInstanceOf(CollaborationParticipantResolverError);
    }
  });
});
