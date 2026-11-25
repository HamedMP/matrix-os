/**
 * A draft that `draftIssues` accepts must also pass every limit on its way to
 * the provider: the shell bridge measures the whole request frame (the params
 * JSON is escaped a second time inside it) against 64 KiB, and the gateway's
 * compose schemas measure the params, reply threading included, against
 * 60,000 bytes. Fault caught: a quote-heavy or long-threaded reply that the
 * composer says fits, then fails to save with a generic error.
 */
import { describe, expect, it } from "vitest";
import { createGmailProvider } from "../../../../home/apps/_shared/office-accounts/mail/gmail-provider";
import {
  draftIssues, emptyDraft, mailAccountId, type Draft, type MailAccount,
} from "../../../../home/apps/_shared/office-accounts/types/mail";
import { FakeBridge, b64url } from "./fake-bridge";
import { GMAIL_MESSAGE_A1_FULL } from "./gmail-fixtures";

const ACCOUNT: MailAccount = { id: mailAccountId("gmail", "owner@example.com"), provider: "gmail", address: "owner@example.com", displayName: "Owner" };
/** `MAX_APP_CAPABILITY_BYTES`: the shell bridge's cap on one request frame. */
const BRIDGE_FRAME_BYTES = 65_536;
/** The gateway compose schemas' cap on the params of one call. */
const GATEWAY_PARAMS_BYTES = 60_000;

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/** The frame `os-bridge.ts` `parentFetch` measures for `MatrixOS.service(...)`. */
function bridgeFrameBytes(service: string, action: string, params: unknown, label: string): number {
  const body = JSON.stringify({ kind: "integrations.call", service, action, params, label });
  return utf8(JSON.stringify({ url: "/api/bridge/capabilities", init: { method: "POST", body } }));
}

/** Quote-heavy HTML, like a redlined or quoted reply: many attributes per line. */
function quotedHtml(lines: number): string {
  return Array.from({ length: lines }, (_, i) =>
    `<div><ins class="redline-ins" data-change-id="c${i}" data-author="Assistant" title="Inserted by Assistant">line ${i}</ins></div>`).join("");
}

/** The largest body of this shape that `draftIssues` still accepts. */
function largestAcceptedDraft(base: Draft): Draft {
  let low = 1;
  let high = 2000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = { ...base, bodyHtml: quotedHtml(mid), bodyText: "x".repeat(mid * 10) };
    if (draftIssues(candidate).length === 0) low = mid; else high = mid - 1;
  }
  const best = { ...base, bodyHtml: quotedHtml(low), bodyText: "x".repeat(low * 10) };
  expect(draftIssues(best)).toEqual([]);
  return best;
}

function longThreadOriginal() {
  const references = Array.from({ length: 30 }, (_, i) => `<${"r".repeat(150)}-${i}@mail.example.com>`).join(" ");
  return {
    ...GMAIL_MESSAGE_A1_FULL,
    payload: {
      ...GMAIL_MESSAGE_A1_FULL.payload,
      headers: GMAIL_MESSAGE_A1_FULL.payload.headers.map((h) => (h.name === "References" ? { name: "References", value: references } : h)),
    },
  };
}

async function sentParams(draft: Draft, original = GMAIL_MESSAGE_A1_FULL) {
  const bridge = new FakeBridge();
  const provider = createGmailProvider({ account: ACCOUNT, label: "work", bridge });
  bridge.reply("gmail", "get_message", original)
    .handle("gmail", "create_reply_draft", () => ({ id: "r-1", message: { id: "m-r", threadId: "18c1a" } }))
    .handle("gmail", "create_html_draft", () => ({ id: "r-1", message: { id: "m-r", threadId: "18c1a" } }));
  await provider.saveDraft(draft);
  const call = bridge.calls.find((c) => c.action === "create_reply_draft" || c.action === "create_html_draft");
  if (!call) throw new Error("no draft call");
  return call;
}

describe("draft request budget", () => {
  const base: Draft = { ...emptyDraft(), to: [{ address: "ada@example.com", name: "Ada Lovelace" }], subject: "Re: Review" };

  it("keeps an accepted quote-heavy new draft inside the bridge frame limit", async () => {
    const draft = largestAcceptedDraft(base);
    const call = await sentParams(draft);
    expect(bridgeFrameBytes("gmail", call.action, call.params, "work")).toBeLessThanOrEqual(BRIDGE_FRAME_BYTES);
    expect(utf8(JSON.stringify(call.params))).toBeLessThanOrEqual(GATEWAY_PARAMS_BYTES);
  });

  it("keeps an accepted reply with a long References chain inside both limits", async () => {
    const draft = largestAcceptedDraft({ ...base, inReplyToMessageId: "m-a1" });
    const call = await sentParams(draft, longThreadOriginal());
    expect(call.action).toBe("create_reply_draft");
    expect(call.params.inReplyTo).toBe("<CAF-a1@mail.example.com>");
    const references = call.params.references as string[];
    // The thread root and the message answered stay; middle ids give way to the budget.
    expect(references[0]).toMatch(/r-0@mail\.example\.com>$/);
    expect(references.at(-1)).toBe("<CAF-a1@mail.example.com>");
    expect(bridgeFrameBytes("gmail", call.action, call.params, "work")).toBeLessThanOrEqual(BRIDGE_FRAME_BYTES);
    expect(utf8(JSON.stringify(call.params))).toBeLessThanOrEqual(GATEWAY_PARAMS_BYTES);
  });

  it("still lets base64 attachments use the room a plain body leaves", () => {
    // Base64 needs no escaping, so the budget for files is unchanged by the frame rule.
    const content = b64url("a".repeat(30_000)).replace(/-/g, "+").replace(/_/g, "/");
    const padded = content + "=".repeat((4 - (content.length % 4)) % 4);
    const draft = { ...base, bodyHtml: "<p>Hi</p>", bodyText: "Hi", attachments: [{ name: "a.txt", mimeType: "text/plain", size: 30_000, contentBase64: padded }] };
    expect(draftIssues(draft)).toEqual([]);
  });
});
