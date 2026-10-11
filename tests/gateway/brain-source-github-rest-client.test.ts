import { describe, expect, it, vi } from "vitest";
import {
  createGithubRestClient, githubRequestKey, githubResourcePath,
} from "../../packages/gateway/src/brain/sources/github/rest-client.js";
import type { BrainGithubValidators } from "../../packages/gateway/src/brain/sources/github/types.js";
import { fakeFetch, githubFixture, jsonResponse } from "./helpers/brain-source-github-fakes.js";

const TOKEN = "ghp_testtoken000000000000000000000000";
const listing = { kind: "issues", since: "2026-01-01T00:00:00Z", page: 1, perPage: 50 } as const;
const signal = () => new AbortController().signal;

function client(responses: Parameters<typeof fakeFetch>[0], extra: Partial<Parameters<typeof createGithubRestClient>[0]> = {}) {
  const fake = fakeFetch(responses);
  return { fake, client: createGithubRestClient({ token: TOKEN, repo: "acme/widgets", fetch: fake.fetch, now: () => 1_000_000_000, ...extra }) };
}

describe("github REST client", () => {
  it("builds bounded api.github.com requests with the token only in the Authorization header", async () => {
    const { fake, client: rest } = client([jsonResponse(githubFixture("issues-page"), 200, { link: '<https://api.github.com/x?page=2>; rel="next"' })]);
    const result = await rest.read(listing, signal());
    expect(result).toMatchObject({ ok: true, hasMore: true });
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/issues?state=all&sort=updated&direction=asc&since=2026-01-01T00%3A00%3A00Z&per_page=50&page=1");
    expect(call.url).not.toContain(TOKEN);
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps every resource to its path", () => {
    expect(githubResourcePath("acme/widgets", { kind: "pull", number: 12 })).toBe("/repos/acme/widgets/pulls/12");
    expect(githubResourcePath("acme/widgets", { kind: "pull_commits", number: 12, perPage: 100 })).toBe("/repos/acme/widgets/pulls/12/commits?per_page=100");
    expect(githubResourcePath("acme/widgets", { kind: "pull_reviews", number: 12, perPage: 100 })).toBe("/repos/acme/widgets/pulls/12/reviews?per_page=100");
    expect(githubResourcePath("acme/widgets", { kind: "pull_review_comments", number: 12, perPage: 100 })).toBe("/repos/acme/widgets/pulls/12/comments?per_page=100");
  });

  it("sends stored validators on the listing, remembers new ones and reports 304 as not modified", async () => {
    const remembered: [string, BrainGithubValidators][] = [];
    const conditional = {
      lookup: vi.fn(async () => ({ etag: 'W/"abc"', lastModified: "Wed, 21 Oct 2026 07:28:00 GMT" })),
      remember: (key: string, validators: BrainGithubValidators) => remembered.push([key, validators]),
    };
    const { fake, client: rest } = client([
      new Response(null, { status: 304 }),
      jsonResponse([], 200, { etag: '"def"', "last-modified": "not a date" }),
      jsonResponse([], 200, { etag: "unquoted", "last-modified": "Thu, 22 Oct 2026 07:28:00 GMT" }),
      jsonResponse([], 200),
      jsonResponse({ number: 12 }, 200, { etag: '"pull"' }),
    ], { conditional });
    expect(await rest.read(listing, signal())).toEqual({ ok: true, notModified: true });
    const headers = new Headers(fake.calls[0]!.init.headers);
    expect(headers.get("if-none-match")).toBe('W/"abc"');
    expect(headers.get("if-modified-since")).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    await rest.read(listing, signal());
    await rest.read(listing, signal());
    await rest.read(listing, signal());
    const key = githubRequestKey(githubResourcePath("acme/widgets", listing));
    expect(remembered).toEqual([
      [key, { etag: '"def"', lastModified: null }], [key, { etag: null, lastModified: "Thu, 22 Oct 2026 07:28:00 GMT" }],
    ]);
    await rest.read({ kind: "pull", number: 12 }, signal());
    expect(conditional.lookup).toHaveBeenCalledTimes(4);
    expect(remembered).toHaveLength(2);
  });

  it("turns rate-limit answers into rate_limited with bounded waits and stops calling until the reset", async () => {
    const reset = String(1_000_000 + 120);
    const { fake, client: rest } = client([
      jsonResponse({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }),
    ]);
    expect(await rest.read(listing, signal())).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 120 });
    expect(await rest.read(listing, signal())).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 120 });
    expect(fake.calls).toHaveLength(1);
  });

  it("uses retry-after, caps it, and treats a spent budget on a success as a stop for later calls", async () => {
    const first = client([jsonResponse({}, 429, { "retry-after": "999999" })]);
    expect(await first.client.read(listing, signal())).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 3600 });
    const second = client([jsonResponse({}, 429)]);
    expect(await second.client.read(listing, signal())).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 60 });
    const third = client([jsonResponse([], 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "bad" })]);
    expect(await third.client.read(listing, signal())).toMatchObject({ ok: true });
    expect(await third.client.read(listing, signal())).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 60 });
  });

  it("treats a 403 whose message names a rate limit as rate_limited, and any other bare 403 as auth_failed", async () => {
    // GitHub's secondary rate limit can come as a 403 with no rate-limit headers, only this message.
    const secondary = client([jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403)]);
    expect(await secondary.client.read(listing, signal())).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 60 });
    expect(await secondary.client.read(listing, signal())).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 60 });
    expect(secondary.fake.calls).toHaveLength(1);
    for (const body of [{ message: "Bad credentials" }, { message: 5 }, ["rate limit"], "rate limit"]) {
      expect(await client([jsonResponse(body, 403)]).client.read(listing, signal())).toEqual({ ok: false, code: "auth_failed" });
    }
  });

  it.each([
    [401, "auth_failed"], [403, "auth_failed"], [404, "remote_not_found"], [410, "remote_not_found"],
    [301, "remote_not_found"], [422, "config_invalid"], [400, "config_invalid"], [500, "provider_unavailable"],
    [418, "provider_unavailable"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const { client: rest } = client([new Response("{}", { status })]);
    expect(await rest.read(listing, signal())).toEqual({ ok: false, code });
  });

  it("refuses oversized and malformed bodies", async () => {
    const big = client([new Response("[]", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } })]);
    expect(await big.client.read(listing, signal())).toEqual({ ok: false, code: "provider_output_invalid" });
    const bad = client([new Response("{not json", { status: 200 })]);
    expect(await bad.client.read(listing, signal())).toEqual({ ok: false, code: "provider_output_invalid" });
    const empty = client([new Response(null, { status: 200 })]);
    expect(await empty.client.read(listing, signal())).toEqual({ ok: false, code: "provider_output_invalid" });
  });

  it("maps timeouts, aborts and network failures, and rethrows anything else", async () => {
    const timeout = client([Object.assign(new Error("timed out"), { name: "TimeoutError" })]);
    expect(await timeout.client.read(listing, signal())).toEqual({ ok: false, code: "provider_timeout" });
    const network = client([new TypeError("fetch failed")]);
    expect(await network.client.read(listing, signal())).toEqual({ ok: false, code: "provider_unavailable" });
    const controller = new AbortController();
    controller.abort();
    const aborted = client([new Error("stopped")]);
    expect(await aborted.client.read(listing, controller.signal)).toEqual({ ok: false, code: "provider_timeout" });
    const odd = client([new RangeError("odd")]);
    await expect(odd.client.read(listing, signal())).rejects.toThrow(RangeError);
    const plain = client([() => Promise.reject("plain")]);
    await expect(plain.client.read(listing, signal())).rejects.toBe("plain");
    const slow = client([(call) => new Promise<Response>((_resolve, reject) => {
      call.init.signal!.addEventListener("abort", () => reject(call.init.signal!.reason));
    })], { timeoutMs: 5 });
    expect(await slow.client.read(listing, signal())).toEqual({ ok: false, code: "provider_timeout" });
  });
});
