import { describe, it, expect, vi } from "vitest";
import { getService, getServiceByPipedreamApp, listServices } from "../../packages/gateway/src/integrations/registry.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const apps = ["asana", "airtable", "clickup", "todoist", "dropbox", "box", "microsoft_outlook", "microsoft_onedrive", "microsoft_teams", "hubspot", "zoom", "google_slides"];
describe("OAuth marketplace expansion", () => {
  it("exposes the expanded OAuth catalog with executable actions", () => {
    expect(listServices()).toHaveLength(38);
    for (const id of apps) {
      const service = getService(id)!;
      expect(service.authType).toBe("oauth");
      expect(service.description).toBeTruthy();
      expect(service.pipedreamApp).toBe(id === "airtable" ? "airtable_oauth" : id);
      expect(Object.keys(service.actions).length).toBeGreaterThanOrEqual(2);
      for (const action of Object.values(service.actions)) {
        expect(action.directApi).toBeDefined();
        expect(["read", "write"]).toContain(action.risk);
      }
    }
  });
  it("provides genuine catalog or vendor logos before remote catalog enrichment", () => {
    for (const service of listServices()) {
      if (service.id === "twitter") expect(service.logoUrl).toBe("/integration-logos/x.svg");
      else if (service.id === "granola") expect(service.logoUrl).toBe("https://www.granola.ai/favicon/favicon-96x96.png");
      else if (service.id === "bokio") expect(service.logoUrl).toBe("https://www.bokio.se/assets/images/icons/favicon.ico");
      else expect(service.logoUrl).toMatch(/^https:\/\/pipedream\.com\/s\.v0\/app_[A-Za-z0-9]+\/logo\/96$/);
    }
  });
  it("keeps credential-based integrations truthful", () => {
    expect(getService("posthog")?.authType).toBe("keys");
    expect(getService("stripe")?.authType).toBe("keys");
  });
  it("uses the OAuth Airtable app and safely encodes validated resource ids", () => {
    expect(getServiceByPipedreamApp("airtable_oauth")?.id).toBe("airtable");
    expect(getServiceByPipedreamApp("airtable")).toBeUndefined();
    const action = getService("airtable")!.actions.list_records;
    expect(validateActionParams(action, { baseId: "app123", tableId: "tbl123" }).valid).toBe(true);
    for (const tableId of ["../secrets", "x/y", "", "a".repeat(200)]) {
      expect(validateActionParams(action, { baseId: "app123", tableId }).valid).toBe(false);
    }
    expect(validateActionParams(action, { baseId: "app123", tableId: "tbl123", limit: Infinity }).valid).toBe(false);
    expect(validateActionParams(action, { baseId: "app123", tableId: "tbl123", limit: 1.5 }).valid).toBe(false);
  });
  it("accepts native OneDrive and Slides IDs while encoding their separators", () => {
    const oneDrive = getService("microsoft_onedrive")!.actions.get_file;
    expect(validateActionParams(oneDrive, { fileId: "A1B2C3!123" }).valid).toBe(true);
    expect(typeof oneDrive.directApi!.url === "function" && oneDrive.directApi!.url({ fileId: "A1B2C3!123" })).toBe("https://graph.microsoft.com/v1.0/me/drive/items/A1B2C3!123");
    const slides = getService("google_slides")!.actions.get_slide;
    expect(validateActionParams(slides, { presentationId: "presentation_123", pageId: "page:123" }).valid).toBe(true);
    expect(typeof slides.directApi!.url === "function" && slides.directApi!.url({ presentationId: "presentation_123", pageId: "page:123" })).toContain("/pages/page%3A123");
  });
  it("executes Outlook reads through the existing owner-bound proxy", async () => {
    const proxyGet = vi.fn().mockResolvedValue({ value: [] });
    const service = getService("microsoft_outlook")!;
    await executeIntegrationAction({
      pipedream: { proxyGet } as unknown as PipedreamConnectClient,
      externalUserId: "owner", connection: { pipedream_account_id: "account" },
      def: service, actionDef: service.actions.list_messages,
      serviceId: service.id, actionId: "list_messages", params: { limit: 20 },
    });
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      externalUserId: "owner", accountId: "account", url: "https://graph.microsoft.com/v1.0/me/messages",
      params: expect.objectContaining({ "$top": "20" }),
    }));
  });
});
