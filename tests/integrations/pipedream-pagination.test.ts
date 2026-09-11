import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { actionsList, accountsList } = vi.hoisted(() => ({ actionsList: vi.fn(), accountsList: vi.fn() }));
vi.mock("@pipedream/sdk", () => ({ PipedreamClient: class {
  actions = { list: actionsList };
  accounts = { list: accountsList };
} }));
import { createPipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { collectPipedreamPages } from "../../packages/gateway/src/integrations/pipedream-pagination.js";

// The real SDK mutates its Page object instead of returning a new identity.
function pages(data: unknown[][]) {
  let index = 0;
  const page = {
    data: data[0],
    hasNextPage: () => index < data.length - 1,
    getNextPage: vi.fn(async () => { page.data = data[++index]; return page; }),
  };
  return page;
}
const config = { clientId: "test", clientSecret: "test", projectId: "test" };

describe("complete bounded Pipedream inventories", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("walks the installed SDK's real Page contract", async () => {
    const { PipedreamClient } = await vi.importActual<typeof import("@pipedream/sdk")>("@pipedream/sdk");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ key: "first" }], page_info: { end_cursor: "next" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ key: "last" }], page_info: { end_cursor: "" } })));
    vi.stubGlobal("fetch", fetcher);
    const sdk = new PipedreamClient({ projectId: "test", tokenProvider: { getToken: async () => "test-only" } });
    const page = await sdk.actions.list({ app: "gmail" }, { timeoutInSeconds: 10, maxRetries: 0, abortSignal: AbortSignal.timeout(30_000) });
    expect((await collectPipedreamPages(page)).map((item) => item.key)).toEqual(["first", "last"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain("after=next");
  });

  it("collects action pages, including an empty intermediate page", async () => {
    const page = pages([[{ key: "first", name: "First" }], [], [{ key: "last", name: "Last" }]]);
    actionsList.mockResolvedValue(page);
    const client = await createPipedreamClient(config);
    expect(await client.discoverActions("gmail")).toEqual([{ key: "first", name: "First" }, { key: "last", name: "Last" }]);
    expect(page.getNextPage).toHaveBeenCalledTimes(2);
  });

  it("collects account pages without requesting credentials", async () => {
    accountsList.mockResolvedValue(pages([
      [{ id: "one", app: { nameSlug: "gmail" }, email: "one@example.com" }],
      [{ id: "two", app: "slack", display_name: "Second" }],
    ]));
    const client = await createPipedreamClient(config);
    expect(await client.listAccounts("owner")).toEqual([
      { id: "one", app: "gmail", email: "one@example.com" },
      { id: "two", app: "slack", email: "Second" },
    ]);
    expect(accountsList).toHaveBeenCalledWith({ externalUserId: "owner", includeCredentials: false },
      expect.objectContaining({ timeoutInSeconds: 10, maxRetries: 0, abortSignal: expect.any(AbortSignal) }));
  });

  it("fails instead of returning a partial account inventory on a later-page failure", async () => {
    const page = pages([[{ id: "one", app: "gmail" }], []]);
    page.getNextPage.mockRejectedValue(new Error("rate limited"));
    accountsList.mockResolvedValue(page);
    const client = await createPipedreamClient(config);
    await expect(client.listAccounts("owner")).rejects.toThrow("rate limited");
  });

  it("bounds a broken provider that never finishes pagination", async () => {
    const page = pages([[]]);
    page.hasNextPage = () => true;
    page.getNextPage.mockImplementation(async () => page);
    actionsList.mockResolvedValue(page);
    const client = await createPipedreamClient(config);
    await expect(client.discoverActions("gmail")).rejects.toThrow("pagination limit");
    expect(page.getNextPage.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("bounds total retained entries", async () => {
    actionsList.mockResolvedValue(pages([Array.from({ length: 2001 }, (_, i) => ({ key: `${i}`, name: `${i}` }))]));
    const client = await createPipedreamClient(config);
    await expect(client.discoverActions("gmail")).rejects.toThrow("pagination limit");
  });
});
