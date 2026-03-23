import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  VoiceProvisioner,
  type ProvisionResult,
} from "../../packages/platform/src/voice-provisioner.js";

describe("platform/voice-provisioner", () => {
  const SID = "AC_test_account_sid";
  const TOKEN = "test_auth_token";

  let provisioner: VoiceProvisioner;

  beforeEach(() => {
    provisioner = new VoiceProvisioner({
      accountSid: SID,
      authToken: TOKEN,
    });
    vi.restoreAllMocks();
  });

  describe("provisionNumber", () => {
    it("calls correct Twilio API with Basic auth", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sid: "PN_123",
          phone_number: "+15551234567",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await provisioner.provisionNumber("alice");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json`,
      );
      expect(options.method).toBe("POST");

      const expectedAuth = Buffer.from(`${SID}:${TOKEN}`).toString("base64");
      expect(options.headers.Authorization).toBe(`Basic ${expectedAuth}`);
    });

    it("configures webhook URL correctly", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sid: "PN_123",
            phone_number: "+15551234567",
          }),
        }),
      );

      await provisioner.provisionNumber("alice");

      const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = options.body as URLSearchParams;
      expect(body.get("VoiceUrl")).toBe(
        "https://alice.matrix-os.com/voice/webhook/twilio",
      );
    });

    it("returns phoneNumber and sid on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            sid: "PN_abc123",
            phone_number: "+15559876543",
          }),
        }),
      );

      const result = await provisioner.provisionNumber("bob");

      expect(result).not.toBeNull();
      expect(result!.phoneNumber).toBe("+15559876543");
      expect(result!.sid).toBe("PN_abc123");
    });

    it("returns null on API error (graceful)", async () => {
      const consoleSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => "Bad Request",
        }),
      );

      const result = await provisioner.provisionNumber("alice");

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to provision"),
      );
    });

    it("rejects invalid handle (path traversal prevention)", async () => {
      await expect(
        provisioner.provisionNumber("x.evil.com/path?"),
      ).rejects.toThrow(/Invalid handle/);

      await expect(
        provisioner.provisionNumber("UPPERCASE"),
      ).rejects.toThrow(/Invalid handle/);

      await expect(
        provisioner.provisionNumber(""),
      ).rejects.toThrow(/Invalid handle/);
    });

    it("returns null on network error (graceful)", async () => {
      const consoleSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const result = await provisioner.provisionNumber("alice");

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("releaseNumber", () => {
    it("calls correct DELETE endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "",
      });
      vi.stubGlobal("fetch", mockFetch);

      await provisioner.releaseNumber("PN_abc123");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers/PN_abc123.json`,
      );
      expect(options.method).toBe("DELETE");

      const expectedAuth = Buffer.from(`${SID}:${TOKEN}`).toString("base64");
      expect(options.headers.Authorization).toBe(`Basic ${expectedAuth}`);
    });

    it("handles 404 gracefully (number already gone)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: async () => "Not Found",
        }),
      );

      await expect(
        provisioner.releaseNumber("PN_gone"),
      ).resolves.not.toThrow();
    });

    it("throws on non-404 API error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        }),
      );

      await expect(provisioner.releaseNumber("PN_abc")).rejects.toThrow(
        "Twilio release error 500",
      );
    });
  });
});
