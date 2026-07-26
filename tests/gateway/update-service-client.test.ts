import { describe, expect, it } from "vitest";
import {
  MAX_UPDATE_SERVICE_FRAME_BYTES,
  decodeUpdateServiceResponse,
  encodeUpdateServiceRequest,
} from "../../packages/gateway/src/update-service-client.js";

describe("typed root update service client", () => {
  it("encodes only the four protocol-v1 operations", () => {
    const requests = [
      { schemaVersion: 1, operation: "Apply", target: { kind: "channel", value: "stable" } },
      { schemaVersion: 1, operation: "Apply", target: { kind: "version", value: "v2026.07.26-1" } },
      { schemaVersion: 1, operation: "Repair" },
      { schemaVersion: 1, operation: "Rollback" },
      { schemaVersion: 1, operation: "Status" },
    ] as const;

    for (const request of requests) {
      const frame = encodeUpdateServiceRequest(request);
      expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
      expect(JSON.parse(frame.subarray(4).toString("utf8"))).toEqual(request);
      expect(frame.length).toBeLessThanOrEqual(MAX_UPDATE_SERVICE_FRAME_BYTES + 4);
    }
  });

  it.each([
    { schemaVersion: 2, operation: "Status" },
    { schemaVersion: 1, operation: "Apply" },
    { schemaVersion: 1, operation: "Apply", target: { kind: "channel", value: "nightly" } },
    { schemaVersion: 1, operation: "Apply", target: { kind: "version", value: "../stable" } },
    { schemaVersion: 1, operation: "Apply", target: { kind: "version", value: "--unit" } },
    { schemaVersion: 1, operation: "Apply", target: { kind: "url", value: "https://attacker.invalid/bundle" } },
    { schemaVersion: 1, operation: "Repair", path: "/opt/matrix/app" },
    { schemaVersion: 1, operation: "Rollback", unit: "ssh.service" },
    { schemaVersion: 1, operation: "Status", command: "systemctl" },
    { schemaVersion: 1, operation: "Status", environment: { TOKEN: "secret" } },
    { schemaVersion: 1, operation: "Restart" },
  ])("rejects non-protocol input before connecting: $operation", (request) => {
    expect(() => encodeUpdateServiceRequest(request)).toThrow("Invalid update request");
  });

  it("rejects request and response frames over 128 KiB", () => {
    expect(MAX_UPDATE_SERVICE_FRAME_BYTES).toBe(128 * 1024);
    expect(() => encodeUpdateServiceRequest({
      schemaVersion: 1,
      operation: "Status",
      padding: "x".repeat(MAX_UPDATE_SERVICE_FRAME_BYTES),
    })).toThrow("Invalid update request");

    const oversized = Buffer.alloc(MAX_UPDATE_SERVICE_FRAME_BYTES + 4);
    oversized.writeUInt32BE(MAX_UPDATE_SERVICE_FRAME_BYTES + 1, 0);
    expect(() => decodeUpdateServiceResponse(oversized)).toThrow("Invalid update response");
  });

  it("maps service responses to bounded generic states", () => {
    const payload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      code: "unavailable",
      message: "Update service unavailable",
    }));
    const frame = Buffer.alloc(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);

    expect(decodeUpdateServiceResponse(frame)).toEqual({
      schemaVersion: 1,
      ok: false,
      code: "unavailable",
      message: "Update service unavailable",
    });

    const failedPayload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      status: "failed",
    }));
    const failedFrame = Buffer.alloc(failedPayload.length + 4);
    failedFrame.writeUInt32BE(failedPayload.length, 0);
    failedPayload.copy(failedFrame, 4);
    expect(decodeUpdateServiceResponse(failedFrame)).toEqual({
      schemaVersion: 1,
      ok: true,
      status: "failed",
    });

    const leaked = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      code: "failed",
      message: "curl: https://secret.invalid /opt/matrix/token",
    }));
    const leakedFrame = Buffer.alloc(leaked.length + 4);
    leakedFrame.writeUInt32BE(leaked.length, 0);
    leaked.copy(leakedFrame, 4);
    expect(() => decodeUpdateServiceResponse(leakedFrame)).toThrow("Invalid update response");
  });
});
