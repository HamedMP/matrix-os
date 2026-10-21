import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/document-writes.js";
import { MICROSOFT_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/microsoft-writes.js";
import { FILE_COMMUNICATION_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/file-communication-writes.js";
import { projectIntegrationCatalog } from "../../packages/gateway/src/integrations/catalog-projection.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const maps = { ...DOCUMENT_WRITE_ACTIONS, ...MICROSOFT_WRITE_ACTIONS, ...FILE_COMMUNICATION_WRITE_ACTIONS };
const cases: [string, string, Record<string, unknown>, string, string, Record<string, unknown>][] = [
  ["google_contacts", "create_contact", { givenName: "Ada", familyName: "Lovelace", email: "ada@example.com", phone: "+461234567" }, "POST", "https://people.googleapis.com/v1/people:createContact?personFields=names,emailAddresses,phoneNumbers,metadata", { names: [{ givenName: "Ada", familyName: "Lovelace" }], emailAddresses: [{ value: "ada@example.com" }], phoneNumbers: [{ value: "+461234567" }] }],
  ["google_slides", "create_presentation", { title: "Budget" }, "POST", "https://slides.googleapis.com/v1/presentations", { title: "Budget" }],
  ["google_slides", "add_slide", { presentationId: "deck_1", slideId: "slide_1" }, "POST", "https://slides.googleapis.com/v1/presentations/deck_1:batchUpdate", { requests: [{ createSlide: { objectId: "slide_1", slideLayoutReference: { predefinedLayout: "BLANK" } } }] }],
  ["google_slides", "replace_slide_text", { presentationId: "deck_1", pageId: "slide_1", findText: "old", replaceText: "new" }, "POST", "https://slides.googleapis.com/v1/presentations/deck_1:batchUpdate", { requests: [{ replaceAllText: { containsText: { text: "old", matchCase: true }, replaceText: "new", pageObjectIds: ["slide_1"] } }] }],
  ["microsoft_outlook", "create_draft", { subject: "Review", body: "Please review" }, "POST", "https://graph.microsoft.com/v1.0/me/messages", { subject: "Review", body: { contentType: "Text", content: "Please review" } }],
  ["microsoft_outlook_calendar", "create_event", { calendarId: "calendar+=", subject: "Focus", startDateTime: "2026-10-19T10:00:00Z", endDateTime: "2026-10-19T11:00:00Z" }, "POST", "https://graph.microsoft.com/v1.0/me/calendars/calendar%2B%3D/events", { subject: "Focus", start: { dateTime: "2026-10-19T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-19T11:00:00", timeZone: "UTC" } }],
  ["microsoft_onedrive", "create_folder", { parentFolderId: "folder:123", name: "Drafts" }, "POST", "https://graph.microsoft.com/v1.0/me/drive/items/folder%3A123/children", { name: "Drafts", folder: {}, "@microsoft.graph.conflictBehavior": "fail" }],
  ["microsoft_teams", "create_channel", { teamId: "a6e3e874-cfe7-4fdb-b140-915f0b13c522", displayName: "Planning", description: "Roadmap" }, "POST", "https://graph.microsoft.com/v1.0/teams/a6e3e874-cfe7-4fdb-b140-915f0b13c522/channels", { displayName: "Planning", description: "Roadmap", membershipType: "standard" }],
  ["dropbox", "create_folder", { path: "/Projects/Drafts" }, "POST", "https://api.dropboxapi.com/2/files/create_folder_v2", { path: "/Projects/Drafts", autorename: false }],
  ["box", "create_folder", { parentFolderId: "0", name: "Drafts" }, "POST", "https://api.box.com/2.0/folders", { name: "Drafts", parent: { id: "0" } }],
  ["zoom", "create_meeting", { topic: "Review", startTime: "2026-10-19T10:00:00Z", duration: 30 }, "POST", "https://api.zoom.us/v2/users/me/meetings", { topic: "Review", type: 2, start_time: "2026-10-19T10:00:00Z", timezone: "UTC", duration: 30 }],
  ["intercom", "create_contact", { role: "lead", email: "ada@example.com", name: "Ada" }, "POST", "https://api.intercom.io/contacts", { role: "lead", email: "ada@example.com", name: "Ada" }],
  ["intercom", "update_contact", { contactId: "contact_1", name: "Ada", phone: "+461234567" }, "PUT", "https://api.intercom.io/contacts/contact_1", { name: "Ada", phone: "+461234567" }],
];

describe("bounded document, calendar, file and communication writes", () => {
  it.each(cases)("maps %s/%s to its reviewed API", async (serviceId, actionId, params, method, url, body) => {
    const action = maps[serviceId]![actionId]!;
    expect(action.risk).toBe("write");
    expect(action.paramsSchema?.safeParse(params).success).toBe(true);
    expect(action.paramsSchema?.safeParse({ ...params, arbitraryUrl: "https://evil.example" }).success).toBe(false);
    expect(action.paramsSchema?.safeParse({}).success).toBe(false);
    expect(action.directApi?.method).toBe(method);
    const proxyPost = vi.fn(async () => ({ id: "created" }));
    const proxyPut = vi.fn(async () => ({ id: "updated" }));
    const pipedream = { proxyPost, proxyPut } as unknown as PipedreamConnectClient;
    const def = { id: serviceId, actions: maps[serviceId] } as ServiceDefinition;
    const result = await executeIntegrationAction({ pipedream, externalUserId: "owner", connection: { pipedream_account_id: "account" }, def, actionDef: action, serviceId, actionId, params });
    expect(result.data).toBeDefined();
    const expected = { externalUserId: "owner", accountId: "account", url, body,
      ...(serviceId === "intercom" ? { headers: { "Intercom-Version": "2.14" } } : {}) };
    expect(method === "PUT" ? proxyPut : proxyPost).toHaveBeenCalledWith(expected);
    await expect(executeIntegrationAction({ pipedream, externalUserId: "owner", connection: { pipedream_account_id: "account" }, def, actionDef: action, serviceId, actionId, params: { ...params, arbitraryUrl: "https://evil.example" } })).rejects.toThrow("Invalid action parameters");
    expect(proxyPost.mock.calls.length + proxyPut.mock.calls.length).toBe(1);
  });

  it("creates a OneDrive folder using a personal drive item ID and rejects unsafe IDs at both boundaries", async () => {
    const action = MICROSOFT_WRITE_ACTIONS.microsoft_onedrive!.create_folder!;
    const params = { parentFolderId: "A1B2C3!123", name: "Drafts" };
    expect(action.paramsSchema!.safeParse(params).success).toBe(true);
    const proxyPost = vi.fn(async () => ({ id: "created" }));
    await executeIntegrationAction({ pipedream: { proxyPost } as unknown as PipedreamConnectClient, externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: { id: "microsoft_onedrive" } as ServiceDefinition, actionDef: action, serviceId: "microsoft_onedrive", actionId: "create_folder", params });
    expect(proxyPost).toHaveBeenCalledWith({ externalUserId: "owner", accountId: "account", url: "https://graph.microsoft.com/v1.0/me/drive/items/A1B2C3!123/children", body: { name: "Drafts", folder: {}, "@microsoft.graph.conflictBehavior": "fail" } });
    const url = action.directApi!.url as (params: Record<string, unknown>) => string;
    for (const parentFolderId of ["", "../other", "A1B2C3!123?query", "A1B2C3!123#fragment", "A1B2C3!123\n", "A1B2C3!123\u0000", "a".repeat(129)]) {
      expect(action.paramsSchema!.safeParse({ ...params, parentFolderId }).success).toBe(false);
      expect(() => url({ ...params, parentFolderId })).toThrow();
    }
  });

  it("replaces text on an existing short Google Slides page ID without relaxing new slide IDs", async () => {
    const action = DOCUMENT_WRITE_ACTIONS.google_slides!.replace_slide_text!;
    const params = { presentationId: "deck_1", pageId: "p", findText: "old", replaceText: "new" };
    expect(action.paramsSchema!.safeParse(params).success).toBe(true);
    const proxyPost = vi.fn(async () => ({ replies: [{ replaceAllText: { occurrencesChanged: 1 } }] }));
    await executeIntegrationAction({ pipedream: { proxyPost } as unknown as PipedreamConnectClient, externalUserId: "owner", connection: { pipedream_account_id: "account" }, def: { id: "google_slides" } as ServiceDefinition, actionDef: action, serviceId: "google_slides", actionId: "replace_slide_text", params });
    expect(proxyPost).toHaveBeenCalledWith({ externalUserId: "owner", accountId: "account", url: "https://slides.googleapis.com/v1/presentations/deck_1:batchUpdate", body: { requests: [{ replaceAllText: { containsText: { text: "old", matchCase: true }, replaceText: "new", pageObjectIds: ["p"] } }] } });
    expect(DOCUMENT_WRITE_ACTIONS.google_slides!.add_slide!.paramsSchema!.safeParse({ presentationId: "deck_1", slideId: "p" }).success).toBe(false);
    for (const pageId of ["", "../other", "p?query", "p\n", "p".repeat(257)]) {
      expect(action.paramsSchema!.safeParse({ ...params, pageId }).success).toBe(false);
    }
  });

  it.each([
    ["google_contacts", "create_contact", { givenName: "A", email: "invalid" }],
    ["google_contacts", "create_contact", { givenName: " " }],
    ["google_slides", "create_presentation", { title: "x".repeat(201) }],
    ["google_slides", "add_slide", { presentationId: "deck", slideId: "tiny" }],
    ["google_slides", "add_slide", { presentationId: "../other", slideId: "slide_1" }],
    ["google_slides", "replace_slide_text", { presentationId: "deck", pageId: "slide_1", findText: "", replaceText: "new" }],
    ["google_slides", "replace_slide_text", { presentationId: "deck", pageId: "slide_1", findText: "old", replaceText: "x".repeat(10001) }],
    ["microsoft_outlook", "create_draft", { subject: "x", body: "x", toRecipients: [{ emailAddress: { address: "someone@example.com" } }] }],
    ["microsoft_outlook_calendar", "create_event", { calendarId: "c", subject: "x", startDateTime: "2026-10-19T11:00:00Z", endDateTime: "2026-10-19T10:00:00Z" }],
    ["microsoft_outlook_calendar", "create_event", { calendarId: "c", subject: "x", startDateTime: "2026-10-19T11:00:00+01:00", endDateTime: "2026-10-19T12:00:00+01:00" }],
    ["microsoft_outlook_calendar", "create_event", { calendarId: "c", subject: "x", startDateTime: "2026-10-19T11:00:00Z", endDateTime: "2028-10-19T12:00:00Z" }],
    ["microsoft_onedrive", "create_folder", { parentFolderId: "id", name: "../other" }],
    ["microsoft_onedrive", "create_folder", { parentFolderId: "../me", name: "safe" }],
    ["microsoft_teams", "create_channel", { teamId: "../other", displayName: "safe" }],
    ["dropbox", "create_folder", { path: "/Projects/../Other" }],
    ["dropbox", "create_folder", { path: "/Projects//Other" }],
    ["dropbox", "create_folder", { path: "relative" }],
    ["dropbox", "create_folder", { path: "/" }],
    ["box", "create_folder", { parentFolderId: "../other", name: "safe" }],
    ["box", "create_folder", { parentFolderId: "0", name: "bad/name" }],
    ["zoom", "create_meeting", { topic: "x", startTime: "2026-10-19T10:00:00Z", duration: 0 }],
    ["zoom", "create_meeting", { topic: "x", startTime: "2026-10-19T10:00:00Z", duration: 1441 }],
    ["intercom", "create_contact", { role: "admin", email: "ada@example.com" }],
    ["intercom", "update_contact", { contactId: "contact_1" }],
    ["intercom", "update_contact", { contactId: "contact_1", email: "invalid" }],
  ] satisfies [string, string, Record<string, unknown>][])("rejects invalid %s/%s parameters", (service, action, params) => {
    expect(maps[service]![action]!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  it.each([
    ["google_contacts", "create_contact", { givenName: "Ada" }, { names: [{ givenName: "Ada" }] }],
    ["microsoft_teams", "create_channel", { teamId: "a6e3e874-cfe7-4fdb-b140-915f0b13c522", displayName: "Planning" }, { displayName: "Planning", membershipType: "standard" }],
    ["intercom", "create_contact", { role: "user", email: "ada@example.com" }, { role: "user", email: "ada@example.com" }],
    ["intercom", "update_contact", { contactId: "contact_1", email: "ada@example.com" }, { email: "ada@example.com" }],
  ] satisfies [string, string, Record<string, unknown>, Record<string, unknown>][])("maps optional omitted fields for %s/%s", (service, action, params, body) => {
    const def = maps[service]![action]!;
    expect(def.paramsSchema!.safeParse(params).success).toBe(true);
    expect(def.directApi!.mapBody!(params)).toEqual(body);
  });

  it("projects no extension writes into a read-only capability catalog", async () => {
    const services = Object.entries(maps).map(([id, actions]) => ({ id, actions, connectorKind: "pipedream", logoUrl: "" } as ServiceDefinition));
    const projected = await projectIntegrationCatalog({ services, uid: "owner", capabilityIdentityFailed: false, authoritative: true, readOnly: true, logoUrl: service => service.logoUrl });
    expect(projected).toHaveLength(10);
    expect(projected.every(service => Object.keys(service.actions).length === 0)).toBe(true);
  });

  it("keeps the exported extension maps limited to tested write actions", () => {
    expect(Object.keys(maps).sort()).toEqual(["box", "dropbox", "google_contacts", "google_slides", "intercom", "microsoft_onedrive", "microsoft_outlook", "microsoft_outlook_calendar", "microsoft_teams", "zoom"]);
    expect(Object.values(maps).flatMap(Object.values)).toHaveLength(cases.length);
    for (const actions of Object.values(maps)) for (const action of Object.values(actions)) {
      expect(action.risk).toBe("write");
      expect(action.componentKey).toBeUndefined();
    }
  });
});
