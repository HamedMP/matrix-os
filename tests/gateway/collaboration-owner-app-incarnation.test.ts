import { describe, expect, it, vi } from "vitest";
import { createOwnerAppIncarnationResolver } from "../../packages/gateway/src/collaboration/owner-app-incarnation.js";

describe("owner app catalog incarnation wiring", () => {
  it("resolves only the configured owner's standalone registered app", async () => {
    const registeredApp = vi.fn(async (appId: string) => appId === "notes"
      ? { slug: "notes", created_at: "2026-09-21T10:00:00.000Z" }
      : null);
    const resolve = createOwnerAppIncarnationResolver("owner-a", registeredApp);
    const input = { ownerId: "owner-a", projectId: null, appId: "notes" };

    expect(await resolve(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(await resolve({ ...input, ownerId: "owner-b" })).toBeNull();
    expect(await resolve({ ...input, projectId: "project-a" })).toBeNull();
    expect(await resolve({ ...input, appId: "missing" })).toBeNull();
    expect(registeredApp).toHaveBeenCalledTimes(2);
  });

  it("changes the catalog identity when a registered app is recreated", async () => {
    let createdAt = "2026-09-21T10:00:00.000Z";
    const resolve = createOwnerAppIncarnationResolver("owner-a", async () => ({ slug: "notes", created_at: createdAt }));
    const input = { ownerId: "owner-a", projectId: null, appId: "notes" };
    const before = await resolve(input);
    createdAt = "2026-09-21T10:01:00.000Z";
    expect(await resolve(input)).not.toBe(before);
  });
});
