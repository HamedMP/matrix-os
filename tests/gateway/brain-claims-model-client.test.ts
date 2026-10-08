/**
 * The Claude claims client against a fake Messages endpoint (no network, synthetic key): request shape and caching,
 * structured output parsing, refusal, unusable output, SDK error mapping, abort and timeout, and skipped bodies.
 */
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
// The SDK error classes come through the client, so instanceof always checks the SDK copy that threw them.
import {
  AnthropicError, APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError,
  createAnthropicBrainClaimModel, withBoundedRetryWaits,
} from "../../packages/gateway/src/brain/claims/model/client.js";
import { BRAIN_MODEL_SYSTEM_PROMPT } from "../../packages/gateway/src/brain/claims/model/prompt.js";
import {
  BrainModelError, type BrainAnthropicModelOptions,
} from "../../packages/gateway/src/brain/claims/model/types.js";
import {
  errorResponse, fakeAnthropic, jsonResponse, messageBody, SYNTHETIC_KEY, type CapturedRequest,
} from "./helpers/brain-model-fetch.js";

const BODY = [
  "## Decisions",
  "- **Storage:** claims live in the owner database because Postgres is the source of truth for the brain.",
  "## Follow-ups",
  "- Alex will add retry metrics by 2026-11-01.",
  "## Risks",
  "- A large backfill can spend the whole run budget on one scope.",
].join("\n");
const INPUT = {
  title: "feat(brain): model claims", body: BODY, kinds: ["decision", "commitment", "risk", "invariant"], maxClaims: 50,
} as const;
/** 900 input tokens at 40 and 300 output tokens at 200 tenths of a micro-USD. */
const DEFAULT_USAGE = {
  inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 9_600,
};
const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0 };
const NO_FIELDS = { assignee: null, due: null, severity: null };

type Handler = Parameters<typeof fakeAnthropic>[0];
function setup(handler: Handler, overrides: Partial<BrainAnthropicModelOptions> = {}) {
  const fake = fakeAnthropic(handler);
  const model = createAnthropicBrainClaimModel({
    apiKey: SYNTHETIC_KEY, modelId: "claude-opus-5-5", effort: "low", bodyMaxBytes: 32_768, timeoutMs: 10_000,
    fetch: fake.fetch, ...overrides,
  });
  return { model, requests: fake.requests };
}
const ok = (options: Parameters<typeof messageBody>[0] = {}): Handler => () => jsonResponse(200, messageBody(options));
const run = (model: ReturnType<typeof setup>["model"], body: string = BODY, signal = new AbortController().signal) =>
  model.extract({ ...INPUT, body }, signal);
const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(
  () => { throw new Error("expected a rejection"); }, (error: unknown) => error);

describe("brain claims model client", { timeout: 30_000 }, () => {
  let logs: MockInstance[];
  beforeEach(() => {
    logs = (["warn", "error", "log", "info", "debug"] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
  });
  afterEach(() => {
    for (const log of logs) {
      expect(inspect(log.mock.calls, { depth: 8 })).not.toContain(SYNTHETIC_KEY);
      log.mockRestore();
    }
  });

  describe("request", () => {
    it("sends one cached, structured, fallback-enabled Messages request and nothing else", async () => {
      const { model, requests } = setup(ok());
      await run(model);
      expect(requests).toHaveLength(1);
      const [request] = requests as [CapturedRequest];
      expect(request.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
      expect(request.method).toBe("POST");
      expect(request.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(request.headers.get("x-api-key") === SYNTHETIC_KEY).toBe(true);
      expect(request.headers.has("authorization")).toBe(false);
      // A redirect would carry the key and the document to another origin.
      expect(request.redirect).toBe("error");
      const { body } = request;
      expect(Object.keys(body).sort()).toEqual(
        ["fallbacks", "max_tokens", "messages", "model", "output_config", "system"]);
      expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 8_192, fallbacks: "default" });
      expect(body.system).toEqual(
        [{ type: "text", text: BRAIN_MODEL_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
      expect(body.output_config.effort).toBe("low");
      expect(Object.keys(body.output_config.format).sort()).toEqual(["schema", "type"]);
      expect(body.output_config.format.type).toBe("json_schema");
      expect(body.output_config.format.schema.required).toEqual(["claims"]);
      expect(body.output_config.format.schema.properties.claims.type).toBe("array");
      expect(body.messages).toEqual([{ role: "user", content: [
        { type: "text", text: `<document_title>\n${INPUT.title}\n</document_title>` },
        { type: "text", text: `<document_body>\n${BODY}\n</document_body>` },
      ] }]);
    });

    it("keeps the system prompt and output format byte-identical across calls and passes effort through", async () => {
      const { model, requests } = setup(ok(), { effort: "high" });
      await run(model);
      await run(model, `${BODY}\n- Another risk: the cache can expire between runs.`);
      const [first, second] = requests as [CapturedRequest, CapturedRequest];
      expect(JSON.stringify(second.body.system)).toBe(JSON.stringify(first.body.system));
      expect(JSON.stringify(second.body.output_config)).toBe(JSON.stringify(first.body.output_config));
      expect(first.body.output_config.effort).toBe("high");
      expect(second.body.messages).not.toEqual(first.body.messages);
    });
  });

  describe("response", () => {
    it("maps structured output to candidates and drops only unusable labels and fields", async () => {
      const claims = [
        { kind: "decision", label: "Storage", statement: "claims live in the owner database",
          quote: "**Storage:** claims live in the owner database", fields: NO_FIELDS },
        { kind: "commitment", label: "", statement: "Alex will add retry metrics",
          quote: "Alex will add retry metrics by 2026-11-01.",
          fields: { assignee: "Alex", due: "2026-11-01", severity: null } },
        { kind: "risk", label: "x".repeat(81), statement: "A large backfill", quote: "A large backfill",
          fields: { assignee: "  ", due: "2026-02-30", severity: "critical" } },
        { kind: "risk", label: null, statement: "spend the whole run budget", quote: "spend the whole run budget",
          fields: { assignee: null, due: null, severity: "high" } },
        { kind: "opinion", label: null, statement: "s", quote: "q", fields: NO_FIELDS },
      ];
      const { model } = setup(ok({ claims }));
      const output = await run(model);
      expect(output).toEqual({ usage: DEFAULT_USAGE, claims: [
        { kind: "decision", label: "Storage", statement: claims[0]!.statement, quote: claims[0]!.quote },
        { kind: "commitment", label: null, statement: claims[1]!.statement, quote: claims[1]!.quote,
          fields: { assignee: "Alex", due: "2026-11-01" } },
        { kind: "risk", label: null, statement: "A large backfill", quote: "A large backfill" },
        { kind: "risk", label: null, statement: claims[3]!.statement, quote: claims[3]!.quote,
          fields: { severity: "high" } },
        { kind: "opinion", label: null, statement: "s", quote: "q" },
      ] });
      expect(output).not.toHaveProperty("outcome");
    });

    it("reads a fallback-served response and prices every attempt, cache reads and writes included", async () => {
      const iterations = [
        { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 0,
          cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 50,
          cache_read_input_tokens: null, cache_creation_input_tokens: 1_000 },
      ];
      const content = [{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
        { type: "text", text: JSON.stringify({ claims: [] }) }];
      const { model } = setup(ok({ content, model: "claude-opus-4-8", usage: { iterations } }));
      const output = await run(model);
      // 100*40 + 1000*2 + 100*50 + 50*250 + 1000*63 tenths = 86,500 tenths of a micro-USD.
      expect(output).toEqual({ claims: [], usage: {
        inputTokens: 2_200, outputTokens: 50, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, costMicroUsd: 8_650 } });
    });

    it("counts top-level cache reads and writes when there are no iterations", async () => {
      const { model } = setup(ok({ usage: { cache_read_input_tokens: 1_000, cache_creation_input_tokens: 500 } }));
      expect((await run(model)).usage).toEqual(
        { inputTokens: 2_400, outputTokens: 300, cacheReadTokens: 1_000, cacheWriteTokens: 500, costMicroUsd: 12_300 });
    });

    const refusal = { type: "refusal", category: "cyber", explanation: null, recommended_model: null };
    it.each([
      ["a skip, with stop details", refusal, { status: "skipped", code: "model_refused" }],
      ["a skip, without stop details", null, { status: "skipped", code: "model_refused" }],
      // The fallback model was rate-limited or overloaded, so it never ran: retry the revision, never skip it for good.
      ["retryable when the fallback could not run", { ...refusal, recommended_model: "claude-opus-4-8" },
        { status: "invalid" }],
    ])("turns a refusal into %s, with usage counted", async (_name, stopDetails, outcome) => {
      const { model } = setup(() => jsonResponse(200,
        { ...messageBody({ content: [], stopReason: "refusal" }), stop_details: stopDetails }));
      const output = await run(model);
      expect(output).toEqual({ claims: [], usage: DEFAULT_USAGE, outcome });
      expect(output.usage.costMicroUsd).toBeGreaterThan(0);
    });

    it.each([
      ["cut off at max_tokens", { stopReason: "max_tokens" }],
      ["paused", { stopReason: "pause_turn" }],
      ["not JSON", { text: "Here are the claims: none." }],
      ["the wrong shape", { text: "{\"claims\":\"x\"}" }],
      ["two text blocks", { content: [{ type: "text", text: "{\"claims\":[]}" }, { type: "text", text: "{}" }] }],
      ["no text block", { content: [{ type: "thinking", thinking: "", signature: "s" }] }],
    ])("marks a response %s invalid and still counts its usage", async (_name, options) => {
      const { model } = setup(ok(options));
      expect(await run(model)).toEqual({ claims: [], usage: DEFAULT_USAGE, outcome: { status: "invalid" } });
    });
  });

  describe("errors", () => {
    it.each([
      [401, "authentication_error", "model_auth_failed", 1],
      [403, "permission_error", "model_auth_failed", 1],
      [404, "not_found_error", "model_auth_failed", 1],
      [402, "billing_error", "model_auth_failed", 1],
      [408, "timeout_error", "model_unavailable", 2],
      [409, "conflict_error", "model_unavailable", 2],
      [429, "rate_limit_error", "model_unavailable", 2],
      [500, "api_error", "model_unavailable", 2],
      [529, "overloaded_error", "model_unavailable", 2],
      [400, "invalid_request_error", "model_rejected", 1],
      [422, "invalid_request_error", "model_rejected", 1],
      [413, "request_too_large", "model_rejected", 1],
    ] as const)("maps HTTP %i %s to %s after %i fetch(es)", async (status, type, code, fetches) => {
      const { model, requests } = setup(() => errorResponse(status, type));
      const error = await failure(run(model));
      expect(error).toBeInstanceOf(BrainModelError);
      expect((error as BrainModelError).code).toBe(code);
      expect((error as BrainModelError).message).toBe(code);
      expect((error as BrainModelError).cause).toBeInstanceOf(APIError);
      expect(requests).toHaveLength(fetches);
      expect(String(error)).not.toContain(SYNTHETIC_KEY);
      expect(inspect(error, { depth: 8 })).not.toContain(SYNTHETIC_KEY);
    });

    const slow = (status: number, type: string, header: string, value: string) => () => jsonResponse(status,
      { type: "error", error: { type, message: "synthetic" } }, { [header]: value });
    it.each([
      [429, "rate_limit_error", "retry-after", "45"],
      [529, "overloaded_error", "retry-after-ms", "45000"],
      [429, "rate_limit_error", "retry-after", new Date(Date.now() + 120_000).toUTCString()],
    ] as const)("fails at once as model_unavailable when a %i asks to wait (%s %s)", async (status, type, header, value) => {
      const { model, requests } = setup(slow(status, type, header, value));
      const started = performance.now();
      const error = await failure(run(model));
      expect((error as BrainModelError).code).toBe("model_unavailable");
      expect((error as BrainModelError).cause).toBeInstanceOf(APIError);
      expect(requests).toHaveLength(1);
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    it("retries a failure that names no wait once, after the SDK's own short backoff", async () => {
      const { model, requests } = setup(() => jsonResponse(503, { type: "error", error: { type: "api_error", message: "x" } }));
      expect(await failure(run(model))).toMatchObject({ code: "model_unavailable" });
      expect(requests).toHaveLength(2);
    });

    it("passes short waits through and marks long ones, adding a timeout to a call without a signal", async () => {
      const fake = fakeAnthropic((_request, call) => call === 1 ? jsonResponse(200, { ok: 1 }, { "retry-after": "60" })
        : jsonResponse(529, { busy: 1 }, { "retry-after": call === 2 ? "5" : "6" }));
      const bounded = withBoundedRetryWaits(fake.fetch, 1_000);
      const responses = [await bounded("https://api.anthropic.com/v1/messages"),
        await bounded("https://api.anthropic.com/v1/messages"), await bounded("https://api.anthropic.com/v1/messages")];
      expect(responses.map((response) => [response.status, response.headers.get("x-should-retry")]))
        .toEqual([[200, null], [529, null], [529, "false"]]);
      expect(await responses[2]!.json()).toEqual({ busy: 1 });
      expect(fake.requests.every((request) => request.signal instanceof AbortSignal && !request.signal.aborted)).toBe(true);
    });

    it("bounds waits and refuses redirects on the global fetch when none is injected", async () => {
      const fake = fakeAnthropic(slow(429, "rate_limit_error", "retry-after", "45"));
      vi.stubGlobal("fetch", fake.fetch);
      try {
        const model = createAnthropicBrainClaimModel({
          apiKey: SYNTHETIC_KEY, modelId: "claude-opus-5-5", effort: "low", bodyMaxBytes: 32_768, timeoutMs: 10_000,
        });
        expect(await failure(run(model))).toMatchObject({ code: "model_unavailable" });
        expect(fake.requests.map((request) => request.redirect)).toEqual(["error"]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("maps a network failure to model_unavailable after one retry", async () => {
      const { model, requests } = setup(() => { throw new TypeError("fetch failed"); });
      const error = await failure(run(model));
      expect(error).toBeInstanceOf(BrainModelError);
      expect((error as BrainModelError).code).toBe("model_unavailable");
      expect((error as BrainModelError).cause).toBeInstanceOf(APIConnectionError);
      expect(requests).toHaveLength(2);
      expect(inspect(error, { depth: 8 })).not.toContain(SYNTHETIC_KEY);
    });

    it("rethrows a failure that is not an SDK error untouched (the job records model_failed)", async () => {
      const { model, requests } = setup(() =>
        new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
      const error = await failure(run(model));
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error).not.toBeInstanceOf(AnthropicError);
      expect(requests).toHaveLength(1);
    });

    it("rethrows an unexpected error while parsing the output instead of calling it invalid", async () => {
      const text = "{ \"claims\": [] }";
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((source: string, reviver) => {
        if (source === text) throw new RangeError("synthetic");
        return parse(source, reviver);
      });
      try {
        const { model } = setup(ok({ text }));
        expect(await failure(run(model))).toBeInstanceOf(RangeError);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("abort and timeout", () => {
    it("rethrows a caller abort mid-call as the SDK abort error, not a model error", async () => {
      const { model, requests } = setup(() => "hang");
      const controller = new AbortController();
      const pending = failure(run(model, BODY, controller.signal));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      controller.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(APIUserAbortError);
      expect(error).not.toBeInstanceOf(BrainModelError);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.signal?.aborted).toBe(true);
    });

    it("never fetches when the caller signal is already aborted", async () => {
      const { model, requests } = setup(ok());
      const error = await failure(run(model, BODY, AbortSignal.abort()));
      expect(error).toBeInstanceOf(APIUserAbortError);
      expect(requests).toHaveLength(0);
    });

    it("maps the client's own per-attempt timeout to model_timeout after one retry", async () => {
      const { model, requests } = setup(() => "hang", { timeoutMs: 30 });
      const error = await failure(run(model));
      expect(error).toBeInstanceOf(BrainModelError);
      expect((error as BrainModelError).code).toBe("model_timeout");
      expect((error as BrainModelError).cause).toBeInstanceOf(APIConnectionTimeoutError);
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.signal?.aborted === true)).toBe(true);
    });
  });

  describe("skips", () => {
    const squash = ["* feat(brain): add the claims store (#101)", "* fix(brain): close runs on abort (#102)",
      "* test(brain): cover the run fence (#103)", "* chore(brain): rename the extractor id (#104)", "---",
      "Co-authored-by: Alex Example <alex@example.com>", "Signed-off-by: Sam Example <sam@example.com>"].join("\n");
    it.each([
      ["a body under 200 characters", "x".repeat(150), 32_768, "body_too_short"],
      ["a squashed-commit list", squash, 32_768, "commit_list_only"],
      ["a body over the byte cap", "\u00e9".repeat(600), 1_024, "document_too_large"],
    ] as const)("skips %s without a call", async (_name, body, bodyMaxBytes, code) => {
      const { model, requests } = setup(ok(), { bodyMaxBytes });
      // The job asks first, before its spend cap; extract skips the same bodies for any other caller.
      expect(model.skip({ ...INPUT, body })).toBe(code);
      expect(await run(model, body)).toEqual({ claims: [], usage: NO_USAGE, outcome: { status: "skipped", code } });
      expect(requests).toHaveLength(0);
    });

    it("sends a written dash-bullet summary", async () => {
      const bullets = Array.from({ length: 7 }, (_, index) => `- Point ${index}: the store keeps one row per claim.`);
      const { model, requests } = setup(ok());
      expect(bullets.join("\n").length).toBeGreaterThanOrEqual(300);
      expect(model.skip({ ...INPUT, body: bullets.join("\n") })).toBeNull();
      expect(await run(model, bullets.join("\n"))).toEqual({ claims: [], usage: DEFAULT_USAGE });
      expect(requests).toHaveLength(1);
    });
  });
});
