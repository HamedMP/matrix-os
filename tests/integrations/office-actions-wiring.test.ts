import { describe, expect, it } from "vitest";
import { appIntegrationReplyBytes } from "../../packages/contracts/src/app-capabilities.js";
import { INTEGRATION_PRESENTATION } from "../../packages/contracts/src/integration-marketplace.js";
import { MANAGED_WRITE_ACTIONS } from "../../packages/kernel/src/hooks.js";
import { getService, listServices } from "../../packages/gateway/src/integrations/registry.js";
import { CATALOG_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-catalog.js";
import { GMAIL_SERVICE } from "../../packages/gateway/src/integrations/gmail.js";
import { GOOGLE_SERVICES } from "../../packages/gateway/src/integrations/google.js";
import { OAUTH_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-oauth.js";
import { OFFICE_READ_ACTIONS, OFFICE_WRITE_ACTIONS, officeReadActions } from "../../packages/gateway/src/integrations/office-actions.js";
import { GMAIL_COMPOSE_READ_ACTIONS, GMAIL_COMPOSE_REPLY_BYTES, GMAIL_COMPOSE_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/gmail-compose.js";
import { MICROSOFT_MAIL_READ_ACTIONS } from "../../packages/gateway/src/integrations/microsoft-mail-reads.js";
import { MICROSOFT_MAIL_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/microsoft-mail-writes.js";
import { MICROSOFT_MAIL_REPLY_BYTES } from "../../packages/gateway/src/integrations/microsoft-mail-shared.js";
import { MICROSOFT_CALENDAR_SCHEDULING_READ_ACTIONS, MICROSOFT_CALENDAR_SCHEDULING_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/microsoft-calendar-scheduling.js";
import { GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS, GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/google-calendar-scheduling.js";

const OFFICE_WRITES = [
  "gmail/create_html_draft", "gmail/create_reply_draft", "gmail/update_draft", "gmail/delete_draft",
  "gmail/send_draft", "gmail/batch_modify",
  "microsoft_outlook/update_message", "microsoft_outlook/move_message", "microsoft_outlook/create_html_draft",
  "microsoft_outlook/create_reply_draft", "microsoft_outlook/update_draft", "microsoft_outlook/delete_draft",
  "microsoft_outlook/send_draft", "microsoft_outlook/add_attachment",
  "microsoft_outlook_calendar/create_event_with_attendees", "microsoft_outlook_calendar/update_event",
  "microsoft_outlook_calendar/delete_event", "microsoft_outlook_calendar/respond_event",
  "google_calendar/create_event_with_attendees", "google_calendar/update_event_details",
  "google_calendar/delete_event", "google_calendar/respond_event",
];
const OFFICE_READS = [
  "gmail/list_threads_query", "gmail/get_thread", "gmail/get_label", "gmail/list_drafts",
  "microsoft_outlook/get_folder", "microsoft_outlook/list_folder_messages", "microsoft_outlook/search_messages",
  "microsoft_outlook/list_conversation", "microsoft_outlook/get_message", "microsoft_outlook/list_attachments",
  "microsoft_outlook/get_attachment", "microsoft_outlook_calendar/get_schedule", "google_calendar/free_busy",
];
const keys = (map: Record<string, Record<string, unknown>>) =>
  Object.entries(map).flatMap(([service, actions]) => Object.keys(actions).map(action => `${service}/${action}`));
const MIB = 1024 * 1024;

describe("office mail and calendar action wiring", () => {
  it("collects exactly the 22 reviewed writes and 13 reviewed reads", () => {
    expect(keys(OFFICE_WRITE_ACTIONS).sort()).toEqual([...OFFICE_WRITES].sort());
    expect(keys(OFFICE_READ_ACTIONS).sort()).toEqual([...OFFICE_READS].sort());
  });

  it("collects the action objects exactly as the owning modules define them", () => {
    const sources = [GMAIL_COMPOSE_WRITE_ACTIONS, MICROSOFT_MAIL_WRITE_ACTIONS,
      MICROSOFT_CALENDAR_SCHEDULING_WRITE_ACTIONS, GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS];
    for (const source of sources) {
      for (const [service, actions] of Object.entries(source)) {
        for (const [id, action] of Object.entries(actions)) expect(OFFICE_WRITE_ACTIONS[service]?.[id]).toBe(action);
      }
    }
    expect(officeReadActions("gmail")).toEqual(GMAIL_COMPOSE_READ_ACTIONS);
    expect(officeReadActions("microsoft_outlook")).toEqual(MICROSOFT_MAIL_READ_ACTIONS);
    expect(officeReadActions("microsoft_outlook_calendar")).toEqual(MICROSOFT_CALENDAR_SCHEDULING_READ_ACTIONS);
    expect(officeReadActions("google_calendar")).toEqual(GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS);
    expect(officeReadActions("slack")).toEqual({});
  });

  it("publishes every office action on its service in the live registry with validation", () => {
    for (const [map, risk] of [[OFFICE_WRITE_ACTIONS, "write"], [OFFICE_READ_ACTIONS, "read"]] as const) {
      for (const [service, actions] of Object.entries(map)) {
        for (const [id, action] of Object.entries(actions)) {
          expect(getService(service)?.actions[id], `${service}/${id}`).toBe(action);
          expect(action.risk, `${service}/${id}`).toBe(risk);
          expect(action.paramsSchema, `${service}/${id}`).toBeDefined();
          expect(action.directApi, `${service}/${id}`).toBeDefined();
          for (const key of Object.keys(action.params)) expect(typeof action.params[key]!.type).toBe("string");
        }
      }
    }
  });

  it("never shadows an action that a service already defined before the office suite", () => {
    const before: Record<string, Record<string, unknown>> = {
      gmail: GMAIL_SERVICE.actions,
      google_calendar: GOOGLE_SERVICES.google_calendar!.actions,
      microsoft_outlook: OAUTH_SERVICE_REGISTRY.microsoft_outlook!.actions,
      microsoft_outlook_calendar: CATALOG_SERVICE_REGISTRY.microsoft_outlook_calendar!.actions,
    };
    for (const key of [...OFFICE_WRITES, ...OFFICE_READS]) {
      const [service, action] = key.split("/") as [string, string];
      expect(Object.hasOwn(before[service]!, action), key).toBe(false);
    }
    expect(getService("gmail")?.actions.modify_message).toBe(GMAIL_SERVICE.actions.modify_message);
    expect(getService("microsoft_outlook")?.actions.list_messages).toBe(OAUTH_SERVICE_REGISTRY.microsoft_outlook!.actions.list_messages);
  });

  it("keeps Outlook calendar writes out of the read-only catalog definition", () => {
    expect(Object.values(CATALOG_SERVICE_REGISTRY.microsoft_outlook_calendar!.actions).every(action => action.risk === "read")).toBe(true);
    expect(getService("microsoft_outlook_calendar")?.actions.create_event_with_attendees?.risk).toBe("write");
  });

  it("requires owner approval for every office write and none for office reads", () => {
    for (const key of OFFICE_WRITES) expect(MANAGED_WRITE_ACTIONS.has(key), key).toBe(true);
    for (const key of OFFICE_READS) expect(MANAGED_WRITE_ACTIONS.has(key), key).toBe(false);
  });

  it("registers no destructive office action", () => {
    for (const service of listServices()) {
      expect(Object.values(service.actions).every(action => action.risk !== "destructive"), service.id).toBe(true);
    }
  });

  it("raises reply caps for large bodies, attachments and month views as the gateway modules declare", () => {
    for (const [action, bytes] of Object.entries(MICROSOFT_MAIL_REPLY_BYTES)) {
      expect(appIntegrationReplyBytes("microsoft_outlook", action), action).toBe(bytes);
    }
    for (const [key, bytes] of Object.entries(GMAIL_COMPOSE_REPLY_BYTES)) {
      const [service, action] = key.split("/") as [string, string];
      expect(appIntegrationReplyBytes(service, action), key).toBe(bytes);
    }
    expect(appIntegrationReplyBytes("gmail", "get_thread")).toBe(1.5 * MIB);
    expect(appIntegrationReplyBytes("gmail", "get_message")).toBe(1.5 * MIB);
    expect(appIntegrationReplyBytes("gmail", "get_attachment")).toBe(1.5 * MIB);
    expect(appIntegrationReplyBytes("google_calendar", "list_events")).toBe(MIB);
    expect(appIntegrationReplyBytes("microsoft_outlook_calendar", "list_events")).toBe(MIB);
    expect(appIntegrationReplyBytes("microsoft_outlook_calendar", "get_schedule")).toBe(MIB);
    expect(appIntegrationReplyBytes("microsoft_outlook", "send_draft")).toBe(256 * 1024);
    expect(appIntegrationReplyBytes("gmail", "list_threads_query")).toBe(256 * 1024);
  });

  it("describes Outlook mail and calendar with the drafting and scheduling they now offer", () => {
    expect(INTEGRATION_PRESENTATION.microsoft_outlook!.description).toBe("Read, organize, draft, and send email");
    expect(INTEGRATION_PRESENTATION.microsoft_outlook_calendar!.description).toBe("Read calendars and schedule events");
  });
});
