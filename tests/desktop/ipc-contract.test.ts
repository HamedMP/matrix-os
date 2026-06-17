import { describe, expect, it } from "vitest";
import {
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  type InvokeChannel,
} from "@desktop/shared/ipc-contract";

describe("IPC contract", () => {
  it("defines every invoke channel from the contract doc", () => {
    const expected: InvokeChannel[] = [
      "auth:start-device-flow",
      "auth:poll",
      "auth:status",
      "auth:sign-out",
      "runtime:select",
      "state:get",
      "state:set",
      "embed:open",
      "embed:set-bounds",
      "embed:close",
      "embed:retry-auth",
      "notify",
      "badge:set",
      "shell:open-external",
      "update:check",
    ];
    for (const ch of expected) {
      expect(INVOKE_CHANNELS[ch], ch).toBeDefined();
    }
  });

  it("validates auth:poll responses and rejects token leakage shapes", () => {
    const schema = INVOKE_CHANNELS["auth:poll"].response;
    expect(schema.safeParse({ status: "authorized", profile: { handle: "neo", userId: "u1" } }).success).toBe(true);
    expect(schema.safeParse({ status: "pending" }).success).toBe(true);
    // Strict schemas refuse extra fields so a credential can never ride along.
    expect(
      schema.safeParse({ status: "authorized", profile: { handle: "n", userId: "u" }, accessToken: "tok" }).success,
    ).toBe(false);
  });

  it("bounds runtime:select slot", () => {
    const schema = INVOKE_CHANNELS["runtime:select"].request;
    expect(schema.safeParse({ slot: "primary" }).success).toBe(true);
    expect(schema.safeParse({ slot: "" }).success).toBe(false);
    expect(schema.safeParse({ slot: "x".repeat(65) }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("bounds notify payloads", () => {
    const schema = INVOKE_CHANNELS.notify.request;
    expect(
      schema.safeParse({ threadId: "t1", title: "Done", body: "ok", kind: "done" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ threadId: "t1", title: "x".repeat(81), body: "ok", kind: "done" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ threadId: "t1", title: "t", body: "y".repeat(201), kind: "done" }).success,
    ).toBe(false);
    expect(schema.safeParse({ threadId: "t1", title: "t", body: "b", kind: "weird" }).success).toBe(false);
  });

  it("bounds embed bounds rects", () => {
    const schema = INVOKE_CHANNELS["embed:set-bounds"].request;
    expect(
      schema.safeParse({ embedId: "e1", bounds: { x: 0, y: 38, width: 800, height: 600 } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ embedId: "e1", bounds: { x: 0, y: 0, width: 99999, height: 1 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ embedId: "e1", bounds: { x: 0.5, y: 0, width: 10, height: 10 } }).success,
    ).toBe(false);
  });

  it("caps state:set values at 64KB and only allows known keys", () => {
    const schema = INVOKE_CHANNELS["state:set"].request;
    expect(schema.safeParse({ key: "appearance", value: { theme: "dark" } }).success).toBe(true);
    expect(schema.safeParse({ key: "nope", value: 1 }).success).toBe(false);
    const big = { blob: "x".repeat(70_000) };
    expect(schema.safeParse({ key: "panelLayouts", value: big }).success).toBe(false);
  });

  it("only allows https urls on shell:open-external", () => {
    const schema = INVOKE_CHANNELS["shell:open-external"].request;
    expect(schema.safeParse({ url: "https://matrix-os.com" }).success).toBe(true);
    expect(schema.safeParse({ url: "http://matrix-os.com" }).success).toBe(false);
    expect(schema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(schema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
  });

  it("defines event channels with schemas", () => {
    for (const ch of [
      "auth:changed",
      "runtime:changed",
      "embed:state",
      "notification:clicked",
      "update:available",
      "update:ready",
      "window:focus-changed",
    ] as const) {
      expect(EVENT_CHANNELS[ch], ch).toBeDefined();
    }
    expect(
      EVENT_CHANNELS["embed:state"].safeParse({ embedId: "e", state: "auth-required" }).success,
    ).toBe(true);
    expect(EVENT_CHANNELS["embed:state"].safeParse({ embedId: "e", state: "??" }).success).toBe(false);
  });
});
