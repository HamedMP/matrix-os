import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { bindJevInboxRecipe, createJevGmailAccountLookup, listOwnerGmailAccounts, listOwnerGmailAccountsViaPlatform } from "../../packages/gateway/src/chat/jev-recipe-authority.js";

describe("Jev recipe production account lookup", () => {
  it("resolves the authenticated owner to platform ID and excludes foreign, revoked, and non-Gmail rows", async () => {
    const selected = { id: "conn_own", user_id: "platform_own", service: "gmail", account_label: "My Gmail",
      account_email: "me@example.test", status: "active" };
    const db = { getUserByClerkId: vi.fn(async (ownerId: string) => ownerId === "clerk_own"
      ? { id: "platform_own" } : null),
    listConnectedServices: vi.fn(async () => [selected, { ...selected, id: "conn_foreign", user_id: "platform_other" },
      { ...selected, id: "conn_revoked", status: "revoked" }, { ...selected, id: "conn_calendar", service: "calendar" }]) };
    expect(await listOwnerGmailAccounts(db, "clerk_own")).toEqual([selected]);
    expect(db.listConnectedServices).toHaveBeenCalledWith("platform_own");
    expect(await listOwnerGmailAccounts(db, "clerk_other")).toEqual([]);
    expect(db.listConnectedServices).toHaveBeenCalledTimes(1);
  });

  it("uses the customer VPS owner-delegated internal inventory with bounded read-only GET", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json([
      { id: "conn_mine", service: "gmail", account_label: "My Gmail", account_email: "me@example.test", status: "active" },
      { id: "conn_calendar", service: "calendar", account_label: "Calendar", account_email: null, status: "active" },
      { id: "granola_pending", service: "granola", account_label: "Granola", account_email: null, status: "auth_required" },
    ]));
    const lookup = createJevGmailAccountLookup({ db: null,
      internalBaseUrl: "https://platform.internal/internal/containers/owner-handle/integrations",
      machineToken: "synthetic-machine-token", fetcher });
    const rows = await lookup("clerk_own");
    expect(rows).toEqual([{ id: "conn_mine", service: "gmail", account_label: "My Gmail",
      account_email: "me@example.test", status: "active" }]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://platform.internal/internal/containers/owner-handle/integrations");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-machine-token");
    expect(headers.get("x-platform-user-id")).toBe("clerk_own");
    expect(headers.get("x-platform-verified")).toBe(createHmac("sha256", "synthetic-machine-token")
      .update("clerk_own").digest("hex"));
  });

  it.each(["malformed", "oversized", "streamed-overflow", "timeout", "unauthorized", "other-owner", "invalid-gmail"] as const)(
    "fails closed on %s customer inventory", async (caseName) => {
      const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        if (caseName === "timeout") throw new DOMException("Timed out", "TimeoutError");
        if (caseName === "unauthorized") return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (caseName === "malformed") return new Response("{not-json");
        if (caseName === "oversized") return new Response("x".repeat(80_000));
        if (caseName === "streamed-overflow") return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(40_000));
            controller.enqueue(new Uint8Array(40_000));
            controller.close();
          },
        }));
        if (caseName === "invalid-gmail") return Response.json([{ id: "conn_mine", service: "gmail",
          account_label: "My Gmail", account_email: "me@example.test", status: "auth_required" }]);
        const actor = new Headers(init.headers).get("x-platform-user-id");
        return Response.json(actor === "clerk_other" ? [] : [{ id: "conn_mine", service: "gmail",
          account_label: "My Gmail", account_email: "me@example.test", status: "active" }]);
      });
      const input = { ownerId: caseName === "other-owner" ? "clerk_other" : "clerk_own",
        baseUrl: "https://platform.internal/internal/containers/owner-handle/integrations",
        machineToken: "synthetic-machine-token", fetcher };
      if (caseName === "other-owner") expect(await listOwnerGmailAccountsViaPlatform(input)).toEqual([]);
      else await expect(listOwnerGmailAccountsViaPlatform(input)).rejects.toThrow();
    },
  );

  it.each(["missing-id", "missing-email"] as const)("rejects a %s Platform row before saving a binding", async (caseName) => {
    const recipe = { skills: ["matrix-jev-email-triage"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Review proposals" };
    await expect(bindJevInboxRecipe({ ownerId: "clerk_own", recipe,
      listGmailAccounts: async () => [{ id: caseName === "missing-id" ? "" : "conn_mine", service: "gmail",
        account_label: "My Gmail", account_email: caseName === "missing-email" ? null : "me@example.test",
        status: "active" }],
    })).rejects.toMatchObject({ code: "account_unavailable" });
  });
});
