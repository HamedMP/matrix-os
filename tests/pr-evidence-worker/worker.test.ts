import { afterEach, describe, expect, it, vi } from "vitest";
import { base32, EVIDENCE_KEY_PATTERN, createEvidenceKey } from "../../packages/pr-evidence-worker/src/keys.js";
import { TICKET_TTL_MS, MAX_FILE_BYTES, SERVED_CSP } from "../../packages/pr-evidence-worker/src/worker.js";
import { signUploadTicket, verifyUploadTicket } from "../../packages/pr-evidence-worker/src/ticket.js";
import { UploadRateLimiter, BoundedTtlMap } from "../../packages/pr-evidence-worker/src/bounded.js";
import { makeWorker, PNG_FILE, SECRET, TOKEN, uploadRequest, validBody } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function issue(worker: ReturnType<typeof makeWorker>, files: unknown[] = [PNG_FILE]) {
  const response = await worker.handle(uploadRequest(validBody(files)), worker.env);
  return { response, body: (await response.json()) as any };
}

function putRequest(uploadUrl: string, ticket: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Request(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ticket}`,
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      ...headers,
    },
    body: bytes,
  });
}

describe("POST /uploads authorization", () => {
  it("issues upload tickets to a repo writer for an existing PR", async () => {
    const worker = makeWorker();
    const { response, body } = await issue(worker);
    expect(response.status).toBe(200);
    expect(body.files).toHaveLength(1);
    const [file] = body.files;
    expect(file.key).toMatch(/^pr-532\/abcdef1\/[a-z2-7]{26}\.png$/);
    expect(file.url).toBe(`https://evidence.matrix-os.com/${file.key}`);
    expect(file.uploadUrl).toBe(`https://evidence.matrix-os.com/uploads/${file.key}?t=${file.ticket}`);
    expect(typeof file.ticket).toBe("string");
  });

  it("accepts maintain role_name even when the legacy permission field says write", async () => {
    const worker = makeWorker({ scenario: { permission: { permission: "write", role_name: "maintain" } } });
    expect((await issue(worker)).response.status).toBe(200);
  });

  it.each([
    ["read-only collaborator", { permission: { permission: "read", role_name: "read" } }, 403],
    ["triage collaborator", { permission: { permission: "read", role_name: "triage" } }, 403],
    ["non-collaborator (GitHub 404)", { permission: 404 }, 403],
    ["caller cannot view permissions (GitHub 403)", { permission: 403 }, 403],
    ["revoked token", { user: 401 }, 401],
    ["GitHub outage", { user: 502 }, 503],
  ])("denies a %s", async (_label, scenario, status) => {
    const worker = makeWorker({ scenario: scenario as never });
    const { response, body } = await issue(worker);
    expect(response.status).toBe(status);
    expect(JSON.stringify(body)).not.toContain("upstream secret detail");
  });

  it("returns a coarse 503 when GitHub times out", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const worker = makeWorker({ scenario: { fail: timeout as unknown as Error } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { response, body } = await issue(worker);
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "authorization_unavailable" });
  });

  it("sends GitHub calls with a timeout signal, generic user agent, and redirects left unfollowed", async () => {
    const worker = makeWorker();
    await issue(worker);
    const init = worker.fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("user-agent")).toBe("matrix-pr-evidence");
  });

  it("rejects malformed and missing bearer tokens without calling GitHub", async () => {
    const worker = makeWorker();
    expect((await worker.handle(uploadRequest(validBody(), null), worker.env)).status).toBe(401);
    expect((await worker.handle(uploadRequest(validBody(), "short"), worker.env)).status).toBe(401);
    expect(worker.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects tickets for PRs that do not exist in the repo", async () => {
    const worker = makeWorker({ scenario: { pull: 404 } });
    const { response, body } = await issue(worker);
    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "pull_request_not_found" });
  });

  it("caches the allow decision so repeat uploads skip the identity lookups", async () => {
    const worker = makeWorker();
    await issue(worker);
    await issue(worker);
    const userCalls = worker.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/user"));
    expect(userCalls).toHaveLength(1);
  });

  it("re-checks GitHub after the allow cache expires", async () => {
    const worker = makeWorker();
    await issue(worker);
    worker.advance(5 * 60 * 1000 + 1);
    await issue(worker);
    const userCalls = worker.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/user"));
    expect(userCalls).toHaveLength(2);
  });

  it("returns 503 when the ticket secret is not provisioned", async () => {
    const worker = makeWorker();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.handle(uploadRequest(validBody()), { ...worker.env, UPLOAD_TICKET_SECRET: "short" });
    expect(response.status).toBe(503);
  });
});

describe("POST /uploads validation", () => {
  it.each([
    ["SVG", [{ ...PNG_FILE, contentType: "image/svg+xml" }]],
    ["HTML", [{ ...PNG_FILE, contentType: "text/html" }]],
    ["oversized file", [{ ...PNG_FILE, size: MAX_FILE_BYTES + 1 }]],
    ["empty file", [{ ...PNG_FILE, size: 0 }]],
    ["more than 10 files", Array.from({ length: 11 }, () => PNG_FILE)],
    ["no files", []],
  ])("rejects %s", async (_label, files) => {
    const worker = makeWorker();
    const { response } = await issue(worker, files);
    expect(response.status).toBe(400);
  });

  it("rejects a malformed commit", async () => {
    const worker = makeWorker();
    const response = await worker.handle(uploadRequest({ ...validBody(), commit: "nothex!" }), worker.env);
    expect(response.status).toBe(400);
  });

  it("rejects bodies over 16 KB before parsing", async () => {
    const worker = makeWorker();
    const response = await worker.handle(uploadRequest("x".repeat(17 * 1024)), worker.env);
    expect(response.status).toBe(413);
    expect(worker.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with a coarse error", async () => {
    const worker = makeWorker();
    const response = await worker.handle(uploadRequest("{nope"), worker.env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("allows up to 10 files with mixed media types", async () => {
    const worker = makeWorker();
    const files = [
      PNG_FILE,
      { name: "a.jpg", contentType: "image/jpeg", size: 1 },
      { name: "b.webp", contentType: "image/webp", size: 1 },
      { name: "c.gif", contentType: "image/gif", size: 1 },
      { name: "d.mp4", contentType: "video/mp4", size: 1 },
      { name: "e.webm", contentType: "video/webm", size: 1 },
      { name: "f.mov", contentType: "video/quicktime", size: MAX_FILE_BYTES },
    ];
    const { response, body } = await issue(worker, files);
    expect(response.status).toBe(200);
    expect(body.files.map((file: { key: string }) => file.key.split(".").pop())).toEqual([
      "png", "jpg", "webp", "gif", "mp4", "webm", "mov",
    ]);
  });
});

describe("evidence keys", () => {
  it("encodes base32 per RFC 4648 (lowercase, unpadded)", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
  });

  it("mints unique 128-bit keys in the documented format", () => {
    const keys = new Set(Array.from({ length: 500 }, () => createEvidenceKey(7, "0123456789abcdef", "video/mp4")));
    expect(keys.size).toBe(500);
    for (const key of keys) expect(key).toMatch(EVIDENCE_KEY_PATTERN);
  });
});

describe("upload tickets", () => {
  it("round-trips a signed ticket and rejects tampering and expiry", async () => {
    const ticket = { key: "pr-1/abcdef1/" + "a".repeat(26) + ".png", contentType: "image/png" as const, size: 10, expiresAt: 2_000, login: "octo-dev" };
    const signed = await signUploadTicket(SECRET, ticket);
    expect(await verifyUploadTicket(SECRET, signed, 1_000)).toEqual(ticket);
    expect(await verifyUploadTicket(SECRET, signed, 2_000)).toBeNull();
    expect(await verifyUploadTicket("x".repeat(48), signed, 1_000)).toBeNull();
    const [payload, signature] = signed.split(".");
    const forged = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")));
    forged.s = 999;
    const forgedPayload = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyUploadTicket(SECRET, `${forgedPayload}.${signature}`, 1_000)).toBeNull();
  });
});

describe("PUT /uploads/<key>", () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);

  it("stores exactly the ticketed bytes and serves them back", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker);
    const [file] = body.files;
    const put = await worker.handle(putRequest(file.uploadUrl, file.ticket, bytes), worker.env);
    expect(put.status).toBe(201);
    expect(worker.bucket.objects.get(file.key)?.contentType).toBe("image/png");

    const get = await worker.handle(new Request(file.url), worker.env);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("rejects an expired ticket", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker);
    worker.advance(TICKET_TTL_MS);
    const [file] = body.files;
    const put = await worker.handle(putRequest(file.uploadUrl, file.ticket, bytes), worker.env);
    expect(put.status).toBe(403);
  });

  it("rejects a ticket used for a different key", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker, [PNG_FILE, PNG_FILE]);
    const [first, second] = body.files;
    const put = await worker.handle(putRequest(`https://evidence.matrix-os.com/uploads/${second.key}`, first.ticket, bytes), worker.env);
    expect(put.status).toBe(403);
  });

  it("rejects a content type that differs from the ticket", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker);
    const [file] = body.files;
    const put = await worker.handle(putRequest(file.uploadUrl, file.ticket, bytes, { "Content-Type": "image/svg+xml" }), worker.env);
    expect(put.status).toBe(415);
  });

  it("rejects a body whose length differs from the ticket", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker);
    const [file] = body.files;
    const put = await worker.handle(putRequest(file.uploadUrl, file.ticket, new Uint8Array(5)), worker.env);
    expect(put.status).toBe(411);
    expect(worker.bucket.objects.size).toBe(0);
  });

  it("refuses to overwrite an uploaded object", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker);
    const [file] = body.files;
    await worker.handle(putRequest(file.uploadUrl, file.ticket, bytes), worker.env);
    const again = await worker.handle(putRequest(file.uploadUrl, file.ticket, bytes), worker.env);
    expect(again.status).toBe(409);
  });

  it("accepts the ticket from the returned uploadUrl query string", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker);
    const [file] = body.files;
    const put = await worker.handle(
      new Request(file.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png", "Content-Length": String(bytes.byteLength) },
        body: bytes,
      }),
      worker.env,
    );
    expect(put.status).toBe(201);
    const noTicket = await worker.handle(
      new Request(`https://evidence.matrix-os.com/uploads/${file.key}`, { method: "PUT", body: bytes }),
      worker.env,
    );
    expect(noTicket.status).toBe(401);
  });

  it("relies on a conditional R2 write so a racing reuse cannot overwrite", async () => {
    const worker = makeWorker();
    const { body } = await issue(worker);
    const [file] = body.files;
    await worker.handle(putRequest(file.uploadUrl, file.ticket, bytes), worker.env);
    worker.bucket.hideFromHead = true;
    const again = await worker.handle(putRequest(file.uploadUrl, file.ticket, new Uint8Array([9, 9, 9, 9])), worker.env);
    expect(again.status).toBe(409);
    expect(worker.bucket.objects.get(file.key)?.bytes).toEqual(bytes);
  });

  it("hides storage failure details", async () => {
    const worker = makeWorker();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { body } = await issue(worker);
    const [file] = body.files;
    worker.bucket.failPut = true;
    const put = await worker.handle(putRequest(file.uploadUrl, file.ticket, bytes), worker.env);
    expect(put.status).toBe(503);
    expect(await put.text()).not.toContain("/internal/path");
  });
});

describe("enforceExactSize", () => {
  it("errors when the stream is longer or shorter than declared", async () => {
    const { enforceExactSize } = await import("../../packages/pr-evidence-worker/src/worker.js");
    const long = enforceExactSize(new Response(new Uint8Array(6)).body!, 5);
    await expect(new Response(long.stream).arrayBuffer()).rejects.toThrow();
    expect(long.mismatch()).toBe(true);
    const short = enforceExactSize(new Response(new Uint8Array(4)).body!, 5);
    await expect(new Response(short.stream).arrayBuffer()).rejects.toThrow();
    expect(short.mismatch()).toBe(true);
    const exact = enforceExactSize(new Response(new Uint8Array(5)).body!, 5);
    expect((await new Response(exact.stream).arrayBuffer()).byteLength).toBe(5);
    expect(exact.mismatch()).toBe(false);
  });
});

describe("GET /<key>", () => {
  async function stored() {
    const worker = makeWorker();
    const key = createEvidenceKey(532, "abcdef1", "image/png");
    worker.bucket.objects.set(key, { bytes: new Uint8Array([1, 2, 3, 4, 5]), contentType: "text/html" });
    return { worker, key };
  }

  it("serves immutable media with a locked-down content policy derived from the key", async () => {
    const { worker, key } = await stored();
    const response = await worker.handle(new Request(`https://evidence.matrix-os.com/${key}`), worker.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-security-policy")).toBe(SERVED_CSP);
    expect(SERVED_CSP).toBe("default-src 'none'; sandbox");
  });

  it("returns 503, not 404, for a valid key when the bucket binding is missing", async () => {
    const { worker, key } = await stored();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.handle(new Request(`https://evidence.matrix-os.com/${key}`), { ...worker.env, EVIDENCE: undefined });
    expect(response.status).toBe(503);
  });

  it.each(["video/mp4", "video/webm", "video/quicktime"] as const)(
    "lets the browser media document load %s from its own origin while blocking everything else",
    async (type) => {
      const { servedHeaders } = await import("../../packages/pr-evidence-worker/src/worker.js");
      const csp = servedHeaders(type).get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("media-src 'self'");
      expect(csp).toContain("sandbox");
      expect(csp).not.toMatch(/script-src|'unsafe|\*/);
    },
  );

  it.each(["image/png", "image/jpeg", "image/webp", "image/gif"] as const)("keeps %s on the fully locked policy", async (type) => {
    const { servedHeaders } = await import("../../packages/pr-evidence-worker/src/worker.js");
    expect(servedHeaders(type).get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("supports byte ranges for video seeking", async () => {
    const { worker, key } = await stored();
    const response = await worker.handle(
      new Request(`https://evidence.matrix-os.com/${key}`, { headers: { Range: "bytes=1-2" } }),
      worker.env,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-2/5");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([2, 3]));
  });

  it("serves open-ended byte ranges the way browsers request them", async () => {
    const { worker, key } = await stored();
    const response = await worker.handle(
      new Request(`https://evidence.matrix-os.com/${key}`, { headers: { Range: "bytes=2-" } }),
      worker.env,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/5");
    expect(response.headers.get("content-length")).toBe("3");
  });

  it.each([
    "/",
    "/pr-532/",
    "/pr-532/abcdef1/aaaaaaaaaaaaaaaaaaaaaaaaaa.svg",
    "/pr-532/abcdef1/aaaaaaaaaaaaaaaaaaaaaaaaaa.html",
    "/pr-532/abcdef1/aaaaaaaaaaaaaaaaaaaaaaaaaa.png",
  ])("returns 404 for %s", async (path) => {
    const { worker } = await stored();
    const response = await worker.handle(new Request(`https://evidence.matrix-os.com${path}`), worker.env);
    expect(response.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("caps files per login per hour and resets after the window", () => {
    let clock = 0;
    const limiter = new UploadRateLimiter(60, 3_600_000, () => clock);
    expect(limiter.tryConsume("Octo", 50)).toBe(true);
    expect(limiter.tryConsume("octo", 11)).toBe(false);
    expect(limiter.tryConsume("octo", 10)).toBe(true);
    expect(limiter.tryConsume("other", 60)).toBe(true);
    clock = 3_600_000;
    expect(limiter.tryConsume("octo", 60)).toBe(true);
  });

  it("returns 429 once a login exhausts its window", async () => {
    const worker = makeWorker({ limit: 3 });
    expect((await issue(worker, [PNG_FILE, PNG_FILE])).response.status).toBe(200);
    const { response } = await issue(worker, [PNG_FILE, PNG_FILE]);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
  });

  it("keeps bounded maps under their cap", () => {
    const map = new BoundedTtlMap<number>(3, 1_000);
    for (let i = 0; i < 10; i += 1) map.set(String(i), i);
    expect(map.size).toBe(3);
    expect(map.get("9")).toBe(9);
    expect(map.get("0")).toBeUndefined();
  });
});

describe("secret hygiene", () => {
  it("never logs the GitHub token or upload ticket", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const ok = makeWorker();
    const { body } = await issue(ok);
    await ok.handle(new Request(body.files[0].uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${body.files[0].ticket}` } }), ok.env);
    await issue(makeWorker({ scenario: { user: 500 } }));
    await issue(makeWorker({ scenario: { fail: new TypeError(`fetch failed for ${TOKEN}`) } }));
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(body.files[0].ticket);
    expect(logged.length).toBeGreaterThan(0);
  });
});
