import { describe, expect, it, vi } from "vitest";
import {
  CollaborationParticipantResolver,
  CollaborationParticipantResolverError,
} from "../../packages/gateway/src/collaboration/participant-resolver.js";

describe("CollaborationParticipantResolver", () => {
  it("never sends its service token over remote cleartext HTTP", () => {
    const fetchImpl = vi.fn();
    expect(() => new CollaborationParticipantResolver({
      platformBaseUrl: "http://platform.internal",
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      serviceToken: "s".repeat(32),
      fetchImpl,
    })).toThrow("Collaboration platform URL is unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();

    expect(() => new CollaborationParticipantResolver({
      platformBaseUrl: "http://127.0.0.1:8787",
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      serviceToken: "s".repeat(32),
      fetchImpl,
    })).not.toThrow();
  });

  it("returns a validated platform label without forwarding provider errors", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"s".repeat(32)}`);
      return new Response(JSON.stringify({ actorId: "user_editor", displayName: "Editor Person" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const resolver = new CollaborationParticipantResolver({
      platformBaseUrl: "https://platform.internal",
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      serviceToken: "s".repeat(32),
      fetchImpl,
    });
    await expect(resolver.resolve("user_editor")).resolves.toEqual({
      actorId: "user_editor",
      displayName: "Editor Person",
    });
    await expect(resolver.resolve("user_editor")).resolves.toMatchObject({ displayName: "Editor Person" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects mismatched, oversized, and unavailable identity projections generically", async () => {
    const responses = [
      new Response(JSON.stringify({ actorId: "user_other", displayName: "Wrong" })),
      new Response("x".repeat(8_193)),
      new Response("provider database exploded", { status: 503 }),
    ];
    const resolver = new CollaborationParticipantResolver({
      platformBaseUrl: "https://platform.internal",
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      serviceToken: "s".repeat(32),
      fetchImpl: async () => responses.shift()!,
    });
    for (const actorId of ["user_editor", "user_viewer", "user_outsider"]) {
      await expect(resolver.resolve(actorId)).rejects.toBeInstanceOf(CollaborationParticipantResolverError);
    }
  });
});
