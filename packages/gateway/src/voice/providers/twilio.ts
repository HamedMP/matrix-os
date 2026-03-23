import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { VoiceCallProvider } from "./base.js";
import {
  E164Schema,
  type GetCallStatusInput,
  type GetCallStatusResult,
  type HangupCallInput,
  type InitiateCallInput,
  type InitiateCallResult,
  type NormalizedEvent,
  type PlayTtsInput,
  type ProviderWebhookParseResult,
  type StartListeningInput,
  type StopListeningInput,
  type WebhookContext,
  type WebhookVerificationResult,
  type EndReason,
} from "../types.js";

type TwilioConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

const TWILIO_STATUS_MAP: Record<
  string,
  | { type: "call.initiated" }
  | { type: "call.ringing" }
  | { type: "call.answered" }
  | { type: "call.active" }
  | { type: "call.ended"; reason: EndReason }
> = {
  queued: { type: "call.initiated" },
  ringing: { type: "call.ringing" },
  "in-progress": { type: "call.active" },
  completed: { type: "call.ended", reason: "completed" },
  busy: { type: "call.ended", reason: "busy" },
  "no-answer": { type: "call.ended", reason: "no-answer" },
  canceled: { type: "call.ended", reason: "canceled" },
  failed: { type: "call.ended", reason: "failed" },
};

function parseFormBody(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  const sp = new URLSearchParams(raw);
  for (const [key, value] of sp.entries()) {
    params[key] = value;
  }
  return params;
}

export class TwilioProvider implements VoiceCallProvider {
  readonly name = "twilio" as const;
  private config: TwilioConfig;

  constructor(config: TwilioConfig) {
    const e164Result = E164Schema.safeParse(config.fromNumber);
    if (!e164Result.success) {
      throw new Error(
        `Invalid fromNumber: must be E.164 format (e.g. +15551234567)`,
      );
    }
    this.config = config;
  }

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const signature =
      typeof ctx.headers["x-twilio-signature"] === "string"
        ? ctx.headers["x-twilio-signature"]
        : undefined;

    if (!signature) {
      return { ok: false, reason: "Missing x-twilio-signature header" };
    }

    const url = this.reconstructUrl(ctx);
    const params = parseFormBody(ctx.rawBody);

    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
      data += key + params[key];
    }

    const expected = createHmac("sha1", this.config.authToken)
      .update(data)
      .digest("base64");

    if (signature !== expected) {
      return { ok: false, reason: "Invalid signature" };
    }

    return { ok: true };
  }

  parseWebhookEvent(
    ctx: WebhookContext,
  ): ProviderWebhookParseResult {
    const params = parseFormBody(ctx.rawBody);
    const callSid = params.CallSid ?? "";
    const callStatus = params.CallStatus ?? "";
    const from = params.From;
    const to = params.To;

    const mapping = TWILIO_STATUS_MAP[callStatus];
    if (!mapping) {
      return {
        events: [],
        providerResponseBody: "<Response></Response>",
        providerResponseHeaders: { "content-type": "text/xml" },
      };
    }

    const baseEvent = {
      id: `twilio-${callSid}-${callStatus}`,
      callId: callSid,
      providerCallId: callSid,
      timestamp: Date.now(),
      from,
      to,
    };

    let event: NormalizedEvent;
    if (mapping.type === "call.ended") {
      event = { ...baseEvent, type: "call.ended", reason: mapping.reason };
    } else {
      event = { ...baseEvent, type: mapping.type } as NormalizedEvent;
    }

    return {
      events: [event],
      providerResponseBody: "<Response></Response>",
      providerResponseHeaders: { "content-type": "text/xml" },
    };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`;

    const body = new URLSearchParams({
      From: input.from,
      To: input.to,
      Url: input.webhookUrl,
    });

    if (input.inlineTwiml) {
      body.delete("Url");
      body.set("Twiml", input.inlineTwiml);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Twilio API error ${response.status}: ${response.statusText} - ${text}`,
      );
    }

    const data = (await response.json()) as { sid: string };
    return {
      providerCallId: data.sid,
      status: "initiated",
    };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls/${input.providerCallId}.json`;

    const body = new URLSearchParams({ Status: "completed" });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Twilio hangup error ${response.status}: ${response.statusText} - ${text}`,
      );
    }
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const twiml = `<Response><Say>${this.escapeXml(input.text)}</Say></Response>`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls/${input.providerCallId}.json`;

    const body = new URLSearchParams({ Twiml: twiml });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Twilio playTts error ${response.status}: ${response.statusText} - ${text}`,
      );
    }
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const actionUrl = this.config.publicUrl
      ? `${this.config.publicUrl.replace(/\/$/, "")}/voice/webhook/twilio`
      : "/voice/webhook/twilio";
    const twiml = `<Response><Gather input="speech" action="${this.escapeXml(actionUrl)}" method="POST" speechTimeout="auto"><Say>I'm listening.</Say></Gather></Response>`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls/${input.providerCallId}.json`;

    const body = new URLSearchParams({ Twiml: twiml });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Twilio startListening error ${response.status}: ${response.statusText} - ${text}`,
      );
    }
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    // For Twilio, stopping listening is done by sending new TwiML
    const twiml = `<Response><Pause length="1"/></Response>`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls/${input.providerCallId}.json`;

    const body = new URLSearchParams({ Twiml: twiml });

    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  }

  async getCallStatus(
    input: GetCallStatusInput,
  ): Promise<GetCallStatusResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls/${input.providerCallId}.json`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
      },
    });

    if (!response.ok) {
      return { status: "unknown", isTerminal: false, isUnknown: true };
    }

    const data = (await response.json()) as { status: string };
    const terminalStatuses = new Set([
      "completed",
      "busy",
      "no-answer",
      "canceled",
      "failed",
    ]);

    return {
      status: data.status,
      isTerminal: terminalStatuses.has(data.status),
    };
  }

  private reconstructUrl(ctx: WebhookContext): string {
    const proto =
      typeof ctx.headers["x-forwarded-proto"] === "string"
        ? ctx.headers["x-forwarded-proto"]
        : undefined;
    const host =
      typeof ctx.headers["x-forwarded-host"] === "string"
        ? ctx.headers["x-forwarded-host"]
        : undefined;
    const port =
      typeof ctx.headers["x-forwarded-port"] === "string"
        ? ctx.headers["x-forwarded-port"]
        : undefined;

    if (proto && host) {
      const parsedUrl = new URL(ctx.url);
      let reconstructed = `${proto}://${host}`;
      if (port) {
        reconstructed += `:${port}`;
      }
      reconstructed += parsedUrl.pathname;
      if (parsedUrl.search) {
        reconstructed += parsedUrl.search;
      }
      return reconstructed;
    }

    return ctx.url;
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}
