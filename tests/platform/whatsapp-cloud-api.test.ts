import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWhatsAppConfig } from "../../packages/platform/src/whatsapp/config.js";
import {
  canAdmitWhatsAppMessage,
  isWhatsAppReplyWindowOpen,
  isWhatsAppSenderEligible,
  parseWhatsAppMessages,
  sendWhatsAppText,
  verifyWhatsAppSignature,
  WhatsAppSendError,
} from "../../packages/platform/src/whatsapp/cloud-api.js";

const env = {
  WHATSAPP_APP_SECRET: "test-app-secret",
  WHATSAPP_VERIFY_TOKEN: "test-verification-token",
  WHATSAPP_ACCESS_TOKEN: "private-access-token",
  WHATSAPP_PHONE_NUMBER_ID: "123456789",
  WHATSAPP_GRAPH_API_VERSION: "v24.0",
  WHATSAPP_ENCRYPTION_KEY: "a".repeat(64),
  WHATSAPP_PUBLIC_URL: "https://app.example.com",
  WHATSAPP_ALLOWED_SENDERS: "+46700000000,353800000000",
};
const config = () => readWhatsAppConfig(env)!;
const now = Date.UTC(2026, 9, 2);
const event = (overrides: Record<string, unknown> = {}) => ({
  from: "46700000000", id: "wamid.test", timestamp: String(now / 1000),
  type: "text", text: { body: "Hello 🐰" }, ...overrides,
});
const envelope = (messages = [event()], phone = "123456789") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "987654321", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: phone },
    contacts: [{ profile: { name: "Example" }, wa_id: "46700000000" }], messages,
  } }] }],
});
const signed = (raw: string) => `sha256=${createHmac("sha256", env.WHATSAPP_APP_SECRET).update(raw).digest("hex")}`;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WhatsApp pilot configuration", () => {
  it("is disabled when absent and requires the full explicit configuration", () => {
    expect(readWhatsAppConfig({})).toBeUndefined();
    expect(() => readWhatsAppConfig({ WHATSAPP_APP_SECRET: "only-one" })).toThrow("WhatsApp configuration is invalid");
    expect(config()).toMatchObject({ graphVersion: "v24.0", encryptionKey: "a".repeat(64), allowedSenders: ["46700000000", "353800000000"] });
  });
  it.each([
    { WHATSAPP_GRAPH_API_VERSION: "../../other" }, { WHATSAPP_GRAPH_API_VERSION: "" },
    { WHATSAPP_ENCRYPTION_KEY: "a".repeat(63) }, { WHATSAPP_PHONE_NUMBER_ID: "12/path" },
    { WHATSAPP_PUBLIC_URL: "http://app.example.com" }, { WHATSAPP_PUBLIC_URL: "https://user:pass@app.example.com" },
    { WHATSAPP_ALLOWED_SENDERS: "15550000000" }, { WHATSAPP_ALLOWED_SENDERS: "447000000000" },
    { WHATSAPP_ALLOWED_SENDERS: "390669800000" }, { WHATSAPP_ALLOWED_SENDERS: "" },
  ])("rejects unsafe or ineligible configuration %j", (change) => {
    expect(() => readWhatsAppConfig({ ...env, ...change })).toThrow("WhatsApp configuration is invalid");
  });
  it("caps and deduplicates the allowlist", () => {
    expect(readWhatsAppConfig({ ...env, WHATSAPP_ALLOWED_SENDERS: "46700000000,+46700000000" })!.allowedSenders).toEqual(["46700000000"]);
    const senders = Array.from({ length: 101 }, (_, i) => `467${String(i).padStart(8, "0")}`).join(",");
    expect(() => readWhatsAppConfig({ ...env, WHATSAPP_ALLOWED_SENDERS: senders })).toThrow();
  });
  it("supports explicit EEA business-scoped user identifiers", () => {
    expect(readWhatsAppConfig({ ...env, WHATSAPP_ALLOWED_SENDERS: "SE.123abc,NO.user42" })!.allowedSenders).toEqual(["SE.123abc", "NO.user42"]);
    for (const sender of ["US.123abc", "GB.abc", "CH.abc", "SE./bad", "SE.", `SE.${"a".repeat(129)}`]) {
      expect(() => readWhatsAppConfig({ ...env, WHATSAPP_ALLOWED_SENDERS: sender })).toThrow();
      expect(isWhatsAppSenderEligible(sender)).toBe(false);
    }
  });
});

describe("official WhatsApp webhook transport", () => {
  it("classifies malformed JSON and invalid event envelopes as expected input failures", () => {
    for (const raw of ["{", JSON.stringify({ object: "wrong" }), "x".repeat(262145), JSON.stringify(envelope([event({ from: "invalid" })]))]) {
      expect(() => parseWhatsAppMessages(raw, env.WHATSAPP_PHONE_NUMBER_ID)).toThrow(expect.objectContaining({
        name: "WhatsAppInvalidEventError", message: "Invalid WhatsApp event",
      }));
    }
  });
  it("accepts bounded ignored primitive metadata and rejects excessive nesting or node budgets", () => {
    for (const ignored of [null, true, false, 42, { nested: [null, true, 3] }]) {
      expect(parseWhatsAppMessages(JSON.stringify({ ...envelope(), ignored }), env.WHATSAPP_PHONE_NUMBER_ID)).toHaveLength(1);
    }
    let deep: unknown = null;
    for (let depth = 0; depth < 14; depth++) deep = { nested: deep };
    const excessive = [deep, Array.from({ length: 60 }, () => Array(90).fill(null)),
      { ["k".repeat(129)]: true }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`key${i}`, true]))];
    for (const ignored of excessive) {
      expect(() => parseWhatsAppMessages(JSON.stringify({ ...envelope(), ignored }), env.WHATSAPP_PHONE_NUMBER_ID)).toThrow("Invalid WhatsApp event");
    }
    const infiniteNumber = JSON.stringify(envelope()).replace(/}$/, ',"ignored":1e999}');
    expect(() => parseWhatsAppMessages(infiniteNumber, env.WHATSAPP_PHONE_NUMBER_ID)).toThrow("Invalid WhatsApp event");
  });
  it("preserves unexpected parser failures rather than misclassifying them as invalid user input", () => {
    const internalFailure = new Error("parser unavailable");
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw internalFailure; });
    expect(() => parseWhatsAppMessages("{}", env.WHATSAPP_PHONE_NUMBER_ID)).toThrow(internalFailure);
  });
  it("ignores unrelated changes or absent status-only metadata and caps total messages across changes", () => {
    const unrelated = envelope(); unrelated.entry[0].changes[0].field = "account_update";
    expect(parseWhatsAppMessages(JSON.stringify(unrelated), env.WHATSAPP_PHONE_NUMBER_ID)).toEqual([]);
    expect(parseWhatsAppMessages(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [
      { field: "messages", value: {} },
      { field: "messages", value: { metadata: { phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID } } },
    ] }] }), env.WHATSAPP_PHONE_NUMBER_ID)).toEqual([]);
    const many = envelope(Array.from({ length: 60 }, (_, i) => event({ id: `wamid.${i}` })));
    many.entry[0].changes.push(many.entry[0].changes[0]);
    expect(() => parseWhatsAppMessages(JSON.stringify(many), env.WHATSAPP_PHONE_NUMBER_ID)).toThrow("Invalid WhatsApp event");
  });
  it("rejects absent signature secrets and nonfinite or nonpositive window inputs", () => {
    const raw = JSON.stringify(envelope());
    expect(verifyWhatsAppSignature(raw, signed(raw), "")).toBe(false);
    for (const timestamp of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isWhatsAppReplyWindowOpen(timestamp, now)).toBe(false);
    }
    expect(isWhatsAppReplyWindowOpen(now / 1000, Number.NaN)).toBe(false);
    expect(isWhatsAppReplyWindowOpen(now / 1000 + 300, now)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(isWhatsAppReplyWindowOpen(now / 1000)).toBe(true);
    expect(canAdmitWhatsAppMessage(config(), parseWhatsAppMessages(raw, env.WHATSAPP_PHONE_NUMBER_ID)[0])).toBe(true);
  });
  it("verifies the original unicode bytes and rejects malformed or missing signatures", () => {
    const raw = JSON.stringify(envelope());
    expect(verifyWhatsAppSignature(raw, signed(raw), env.WHATSAPP_APP_SECRET)).toBe(true);
    expect(verifyWhatsAppSignature(`${raw} `, signed(raw), env.WHATSAPP_APP_SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(raw, signed(raw), "wrong-secret")).toBe(false);
    for (const signature of [undefined, "", "sha256=abc", `sha256=${"g".repeat(64)}`, "sha1=abc"]) {
      expect(verifyWhatsAppSignature(raw, signature, env.WHATSAPP_APP_SECRET)).toBe(false);
    }
  });
  it("normalizes multiple messages, preserves text, and ignores delivery statuses", () => {
    const raw = envelope([event(), event({ id: "wamid.image", type: "image", text: undefined, image: { id: "media123", mime_type: "image/jpeg", sha256: "a".repeat(44) } })]);
    expect(parseWhatsAppMessages(JSON.stringify(raw), env.WHATSAPP_PHONE_NUMBER_ID)).toEqual([
      { id: "wamid.test", sender: "46700000000", phone: "46700000000", timestamp: now / 1000, type: "text", text: "Hello 🐰" },
      { id: "wamid.image", sender: "46700000000", phone: "46700000000", timestamp: now / 1000, type: "image" },
    ]);
    const status = envelope([]);
    Object.assign(status.entry[0].changes[0].value, { statuses: [{ id: "wamid.outgoing", status: "delivered", timestamp: String(now / 1000), recipient_id: "46700000000" }] });
    expect(parseWhatsAppMessages(JSON.stringify(status), env.WHATSAPP_PHONE_NUMBER_ID)).toEqual([]);
    expect(parseWhatsAppMessages(JSON.stringify(envelope([event()], "another-number")), env.WHATSAPP_PHONE_NUMBER_ID)).toEqual([]);
  });
  it.each([
    event({ from: "../../sender" }), event({ id: "" }), event({ timestamp: "NaN" }),
    event({ text: { body: "a".repeat(4097) } }), event({ type: "text", text: undefined }),
  ])("rejects malformed message boundaries", (message) => {
    expect(() => parseWhatsAppMessages(JSON.stringify(envelope([message])), env.WHATSAPP_PHONE_NUMBER_ID)).toThrow("Invalid WhatsApp event");
  });
  it("bounds envelope size, nested collections and unknown nested values", () => {
    expect(() => parseWhatsAppMessages("{".repeat(262145), env.WHATSAPP_PHONE_NUMBER_ID)).toThrow();
    expect(() => parseWhatsAppMessages(JSON.stringify(envelope(Array.from({ length: 101 }, () => event()))), env.WHATSAPP_PHONE_NUMBER_ID)).toThrow();
    const raw = envelope();
    Object.assign(raw.entry[0].changes[0].value, { unexpected: { nested: "a".repeat(5000) } });
    expect(() => parseWhatsAppMessages(JSON.stringify(raw), env.WHATSAPP_PHONE_NUMBER_ID)).toThrow();
    expect(() => parseWhatsAppMessages("not-json", env.WHATSAPP_PHONE_NUMBER_ID)).toThrow("Invalid WhatsApp event");
  });
  it("admits only configured sender numbers and fresh messages inside the reply window", () => {
    const message = parseWhatsAppMessages(JSON.stringify(envelope()), env.WHATSAPP_PHONE_NUMBER_ID)[0];
    expect(canAdmitWhatsAppMessage(config(), message, now)).toBe(true);
    expect(canAdmitWhatsAppMessage(config(), { ...message, sender: "46700000001", phone: "46700000001" }, now)).toBe(false);
    expect(canAdmitWhatsAppMessage(config(), { ...message, sender: "46700000001", phone: "46700000000" }, now)).toBe(false);
    expect(canAdmitWhatsAppMessage(config(), { ...message, timestamp: now / 1000 - 86400 }, now)).toBe(false);
    expect(canAdmitWhatsAppMessage(config(), { ...message, timestamp: now / 1000 + 301 }, now)).toBe(false);
    expect(isWhatsAppReplyWindowOpen(now / 1000 - 86399, now)).toBe(true);
    expect(isWhatsAppReplyWindowOpen(now / 1000 - 86400, now)).toBe(false);
  });
  it("prefers business-scoped identity and supports a sender without a disclosed number", () => {
    const paired = parseWhatsAppMessages(JSON.stringify(envelope([event({ from_user_id: "SE.123abc" })])), env.WHATSAPP_PHONE_NUMBER_ID)[0];
    expect(paired).toMatchObject({ sender: "SE.123abc", phone: "46700000000" });
    expect(canAdmitWhatsAppMessage(config(), paired, now)).toBe(true);
    const privateSender = parseWhatsAppMessages(JSON.stringify(envelope([event({ from: undefined, from_user_id: "SE.123abc" })])), env.WHATSAPP_PHONE_NUMBER_ID)[0];
    expect(privateSender.sender).toBe("SE.123abc");
    expect(privateSender.phone).toBeUndefined();
    expect(canAdmitWhatsAppMessage(config(), privateSender, now)).toBe(false);
    const explicit = readWhatsAppConfig({ ...env, WHATSAPP_ALLOWED_SENDERS: "SE.123abc" })!;
    expect(canAdmitWhatsAppMessage(explicit, privateSender, now)).toBe(true);
    expect(canAdmitWhatsAppMessage(config(), { ...paired, sender: "US.123abc" }, now)).toBe(false);
  });
  it("rejects malformed or missing business-scoped sender identity", () => {
    for (const message of [event({ from: undefined }), event({ from_user_id: "SE./bad" }), event({ from_user_id: `SE.${"a".repeat(129)}` })]) {
      expect(() => parseWhatsAppMessages(JSON.stringify(envelope([message])), env.WHATSAPP_PHONE_NUMBER_ID)).toThrow("Invalid WhatsApp event");
    }
  });
});

describe("WhatsApp outgoing text", () => {
  const success = () => Response.json({ messaging_product: "whatsapp", contacts: [{ input: "46700000000", wa_id: "46700000000" }], messages: [{ id: "wamid.sent" }] });
  it("uses the default fetch boundary and accepts responses without optional contact metadata", async () => {
    const fetcher = vi.fn(async () => Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.default" }] }));
    vi.stubGlobal("fetch", fetcher);
    await expect(sendWhatsAppText(config(), "46700000000", "Hello")).resolves.toBe("wamid.default");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("treats bodyless successful responses as ambiguous and bodyless rejections as definitive", async () => {
    for (const [status, ambiguous] of [[200, true], [400, false]] as const) {
      await expect(sendWhatsAppText(config(), "46700000000", "Hello", async () => new Response(null, { status }))).rejects.toMatchObject({ ambiguous });
    }
  });
  it("decodes streamed UTF-8 split inside a codepoint and refuses malformed UTF-8", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ messaging_product: "whatsapp", ignored: "🐰", messages: [{ id: "wamid.stream" }] }));
    const split = encoded.indexOf(0xf0) + 2;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoded.slice(0, split)); controller.enqueue(encoded.slice(split)); controller.close();
    } });
    await expect(sendWhatsAppText(config(), "46700000000", "Hello", async () => new Response(stream))).resolves.toBe("wamid.stream");
    await expect(sendWhatsAppText(config(), "46700000000", "Hello", async () => new Response(new Uint8Array([0xff])))).rejects.toMatchObject({ ambiguous: true });
  });
  it("cancels a stalled response when its overall deadline expires without retrying", async () => {
    const controller = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
    const pending = sendWhatsAppText(config(), "46700000000", "Hello", fetcher);
    const assertion = expect(pending).rejects.toMatchObject({ ambiguous: true });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
    await assertion; expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([new Error("private cleanup detail"), "private cleanup detail"])("logs bounded cleanup failures without altering send ambiguity: %j", async (error) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const oversize = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { throw error; } });
    await expect(sendWhatsAppText(config(), "46700000000", "Hello", async () => new Response(oversize))).rejects.toMatchObject({ ambiguous: true });
    expect(logger).toHaveBeenCalledWith("WhatsApp response cleanup failed", error instanceof Error ? "Error" : "UnknownError");
    const rejected = new ReadableStream<Uint8Array>({ cancel() { throw error; } });
    await expect(sendWhatsAppText(config(), "46700000000", "Hello", async () => new Response(rejected, { status: 400 }))).rejects.toMatchObject({ ambiguous: false });
    expect(logger).toHaveBeenCalledWith("WhatsApp rejected-response cleanup failed", error instanceof Error ? "Error" : "UnknownError");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private cleanup detail");
  });
  it("uses the pinned Graph version, bearer credentials, bounded timeout and no redirects", async () => {
    const fetcher = vi.fn(async () => success());
    await expect(sendWhatsAppText(config(), "46700000000", "Hello 🐰", fetcher)).resolves.toBe("wamid.sent");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v24.0/123456789/messages");
    expect(request).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer private-access-token", "Content-Type": "application/json" } });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request.body as string)).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "46700000000", type: "text", text: { preview_url: false, body: "Hello 🐰" } });
  });
  it("never attempts a denied sender or invalid text", async () => {
    const fetcher = vi.fn(async () => success());
    for (const [to, text] of [["46700000001", "hello"], ["46700000000", ""], ["46700000000", "a".repeat(4097)]]) {
      await expect(sendWhatsAppText(config(), to, text, fetcher)).rejects.toMatchObject({ ambiguous: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports explicit HTTP rejection without leaking upstream errors or credentials", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { message: env.WHATSAPP_ACCESS_TOKEN } }, { status: 400 }));
    await expect(sendWhatsAppText(config(), "46700000000", "hello", fetcher)).rejects.toMatchObject({ message: "WhatsApp delivery failed", ambiguous: false });
  });
  it.each([
    async () => { throw new DOMException("token private-access-token", "TimeoutError"); },
    async () => { throw new TypeError("private-access-token connection failed"); },
    async () => Response.json({ messages: [] }),
    async () => new Response("not JSON", { status: 200 }),
    async () => new Response("a".repeat(65537), { status: 200 }),
  ])("marks uncertain outcomes ambiguous and does not retry", async (fetcher) => {
    const call = vi.fn(fetcher);
    await expect(sendWhatsAppText(config(), "46700000000", "hello", call)).rejects.toMatchObject({ message: "WhatsApp delivery failed", ambiguous: true });
    expect(call).toHaveBeenCalledOnce();
  });
  it("exposes a typed safe delivery error", () => {
    expect(new WhatsAppSendError(true)).toMatchObject({ name: "WhatsAppSendError", ambiguous: true, message: "WhatsApp delivery failed" });
  });
  it("uses recipient for business-scoped identities and accepts private-user response metadata", async () => {
    const bsuidConfig = readWhatsAppConfig({ ...env, WHATSAPP_ALLOWED_SENDERS: "SE.123abc" })!;
    const fetcher = vi.fn(async () => Response.json({ messaging_product: "whatsapp", contacts: [{ input: "SE.123abc", user_id: "SE.123abc" }], messages: [{ id: "wamid.private" }] }));
    await expect(sendWhatsAppText(bsuidConfig, "SE.123abc", "Hello", fetcher)).resolves.toBe("wamid.private");
    const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(request.body as string);
    expect(body.recipient).toBe("SE.123abc");
    expect(body).not.toHaveProperty("to");
  });
});
