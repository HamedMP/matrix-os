import { describe, expect, it, vi } from "vitest";
import { AppCapabilityInputSchema, createAppCapabilityClient } from "../../packages/contracts/src/app-capabilities";

describe("app capability contract", () => {
  it("rejects identity injection, arbitrary endpoints and oversized service parameters", () => {
    expect(AppCapabilityInputSchema.safeParse({ kind: "integrations.list", app: "other" }).success).toBe(false);
    expect(AppCapabilityInputSchema.safeParse({ kind: "fetch", url: "https://example.com" }).success).toBe(false);
    expect(AppCapabilityInputSchema.safeParse({ kind: "integrations.call", service: "google_drive", action: "list_files", params: { query: "x".repeat(65_536) } }).success).toBe(false);
  });
  it("keeps the existing service signature and validates before invoking", async () => {
    const invoke = vi.fn(async () => ({ data: { files: [] }, service: "google_drive", action: "list_files" }));
    const client = createAppCapabilityClient(invoke);
    expect(await client.service("google_drive", "list_files", { maxResults: 25 }, "Work")).toEqual({ data: { files: [] }, service: "google_drive", action: "list_files" });
    expect(invoke).toHaveBeenCalledWith({ kind: "integrations.call", service: "google_drive", action: "list_files", params: { maxResults: 25 }, label: "Work" });
    await expect(client.service("../bad", "list_files")).rejects.toThrow("Invalid app capability request");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("returns connected accounts and safe errors without leaking upstream data", async () => {
    const client = createAppCapabilityClient(async () => ({ services: [{ service: "google_drive", account_label: "Work", account_email: "owner@example.test", status: "connected" }] }));
    expect(await client.integrations()).toHaveLength(1);
    const failed = createAppCapabilityClient(async () => { throw new Error("provider token=secret"); });
    await expect(failed.integrations()).rejects.toThrow("App integrations are unavailable");
  });
  it.each([101, 256])("retains all %i connected accounts allowed by the gateway inventory", async (count) => {
    const services = Array.from({ length: count }, (_, index) => ({
      service: "google_drive", account_label: `Account ${index}`, status: "connected",
    }));
    const client = createAppCapabilityClient(async () => ({ services }));
    await expect(client.integrations()).resolves.toEqual(services);
  });
  it("rejects an inventory above the gateway's 256-account bound", async () => {
    const services = Array.from({ length: 257 }, (_, index) => ({
      service: "google_drive", account_label: `Account ${index}`, status: "connected",
    }));
    const client = createAppCapabilityClient(async () => ({ services }));
    await expect(client.integrations()).rejects.toThrow();
  });
});
