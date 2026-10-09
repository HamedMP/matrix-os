import { whatsAppSettingsView } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppSettingsRoutes } from "../../packages/platform/src/whatsapp/settings-routes.js";
import {
  WhatsAppSettingsSchema,
  matrixChatHandoffUrl,
  parseMatrixHandoff,
} from "../../packages/contracts/src/messaging-settings.js";

const connection = {
  sender: "46701234567",
  consentVersion: "whatsapp-general-agent-v1",
  chatId: "chat_whatsapp",
};
function setup(enabled = true) {
  const getConnection = vi.fn(async (_owner: string) => connection);
  const resolveOwner = vi.fn(async () => "owner");
  const app = createWhatsAppSettingsRoutes({
    resolveOwner,
    getConnection: enabled ? getConnection : undefined,
    phoneNumber: "13073174314",
    admissionMode: "allowlist",
  });
  return { app, getConnection, resolveOwner };
}
describe("owner WhatsApp settings", () => {
  it("returns a masked owner link without claiming AI readiness", async () => {
    const { app, getConnection } = setup();
    const res = await app.request("/api/whatsapp/settings");
    expect(res.status).toBe(200);
    const data = WhatsAppSettingsSchema.parse(await res.json());
    expect(data).toEqual({
      connected: true,
      maskedSender: "••••4567",
      admission: "pilot",
      startUrl: "https://wa.me/13073174314",
      chatId: "chat_whatsapp",
    });
    expect(getConnection).toHaveBeenCalledWith("owner");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(data)).not.toContain(connection.sender);
  });
  it("hides stale Chat references when consent is no longer current", async () => {
    const { app, getConnection } = setup();
    getConnection.mockResolvedValueOnce({ ...connection, consentVersion: "old" });
    expect((await (await app.request("/api/whatsapp/settings")).json()).chatId).toBeUndefined();
  });
  it("never reads associations without a verified owner", async () => {
    const { app, resolveOwner, getConnection } = setup();
    resolveOwner.mockResolvedValueOnce(null as never);
    expect((await app.request("/api/whatsapp/settings")).status).toBe(401);
    expect(getConnection).not.toHaveBeenCalled();
  });
  it("reports a disabled deployment truthfully without publishing a phone link", async () => {
    const { app } = setup(false);
    expect(await (await app.request("/api/whatsapp/settings")).json()).toEqual({
      connected: false,
      admission: "unavailable",
    });
  });
  it("does not treat a DB outage or expired consent as an active connection", async () => {
    const { app, getConnection } = setup();
    const diagnostic = new Error("private database diagnostic");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getConnection.mockRejectedValueOnce(diagnostic);
    const res = await app.request("/api/whatsapp/settings");
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("diagnostic");
    expect(log).toHaveBeenCalledWith("[whatsapp/settings] Read failed", diagnostic);
    log.mockRestore();
    getConnection.mockResolvedValueOnce({
      ...connection,
      consentVersion: "old",
    });
    expect(
      (await (await app.request("/api/whatsapp/settings")).json()).connected,
    ).toBe(false);
  });
  it("drops untrusted phone/start URL values and rejects raw sender fields", () => {
    expect(
      WhatsAppSettingsSchema.safeParse({
        connected: true,
        maskedSender: connection.sender,
        admission: "pilot",
      }).success,
    ).toBe(false);
    expect(
      WhatsAppSettingsSchema.safeParse({
        connected: false,
        admission: "public",
        startUrl: "https://evil.test/",
      }).success,
    ).toBe(false);
  });
});
describe("Matrix app handoff", () => {
  const id = "chat_12345678";
  it("uses an HTTPS app link to a bounded canonical Chat reference", () => {
    expect(matrixChatHandoffUrl("https://app.matrix-os.com", id)).toBe(
      "https://app.matrix-os.com/open?chat=" + id,
    );
    expect(parseMatrixHandoff(new URLSearchParams({ chat: id }))).toEqual({
      chatId: id,
    });
  });
  it("rejects duplicate params, auth tokens, arbitrary routes and malformed IDs", () => {
    for (const query of [
      "chat=x&chat=y",
      "token=secret",
      "chat=../../file",
      "redirect=https://evil.test",
    ]) {
      expect(parseMatrixHandoff(new URLSearchParams(query))).toBeNull();
    }
  });
});

describe("shared connection presentation", () => {
  it("hides stale connection actions while checking or after an error", () => {
    const connected = {
      connected: true,
      maskedSender: "••••1234",
      admission: "pilot" as const,
    };
    expect(whatsAppSettingsView(connected, true, false)).toEqual({
      label: "Checking connection…",
      snapshot: null,
    });
    expect(whatsAppSettingsView(connected, false, true)).toEqual({
      label: "Unavailable",
      snapshot: null,
    });
    expect(whatsAppSettingsView(connected, false, false)).toEqual({
      label: "Connected",
      snapshot: connected,
    });
  });
});
