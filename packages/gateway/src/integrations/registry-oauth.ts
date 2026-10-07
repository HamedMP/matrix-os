import { z } from "zod/v4";
import { TODOIST_DEPTH_ACTIONS, HUBSPOT_DEPTH_ACTIONS } from "./task-crm-depth.js";
import type { ActionParam, ServiceAction, ServiceDefinition } from "./types.js";

const ID: ActionParam = { type: "string", required: true, minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_!:-]+$" };
const CURSOR: ActionParam = { type: "string", minLength: 1, maxLength: 1024 };
const LIMIT: ActionParam = { type: "number", minimum: 1, maximum: 100 };
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_!:-]+$/);
const cursorSchema = z.string().min(1).max(1024);
const limitSchema = z.number().int().min(1).max(100);
const segment = (p: Record<string, unknown>, key: string) => encodeURIComponent(idSchema.parse(p[key]));

function read(description: string, url: string | ((p: Record<string, unknown>) => string), ids: string[] = [], page?: { limitKey?: string; cursorKey?: string; cursorParam?: string }): ServiceAction {
  const cursorParam = page?.cursorParam ?? "cursor";
  return {
    description, risk: "read",
    params: Object.fromEntries([
      ...ids.map(id => [id, ID] as const),
      ...(page?.limitKey ? [["limit", LIMIT] as const] : []),
      ...(page?.cursorKey ? [[cursorParam, CURSOR] as const] : []),
    ]),
    paramsSchema: z.object(Object.fromEntries([
      ...ids.map(id => [id, idSchema]),
      ...(page?.limitKey ? [["limit", limitSchema.optional()]] : []),
      ...(page?.cursorKey ? [[cursorParam, cursorSchema.optional()]] : []),
    ])).strict(),
    directApi: {
      method: "GET", url,
      ...(page ? { mapParams: (p: Record<string, unknown>) => ({
        ...(page.limitKey ? { [page.limitKey]: String(p.limit ?? 25) } : {}),
        ...(page.cursorKey && p[cursorParam] ? { [page.cursorKey]: String(p[cursorParam]) } : {}),
      }) } : {}),
    },
  };
}
function service(id: string, name: string, category: string, actions: Record<string, ServiceAction>, slug = id): ServiceDefinition {
  return { id, name, category, connectorKind: "pipedream", pipedreamApp: slug,
    authType: "oauth", icon: "puzzle", logoUrl: `https://pipedream.com/s.v0/${slug}/logo/48`, actions };
}
const graph = "https://graph.microsoft.com/v1.0";
const hubspot = "https://api.hubapi.com/crm/v3/objects";
const todoist = "https://api.todoist.com/api/v1";
const asana = "https://app.asana.com/api/1.0";

// OAuth slugs checked against Pipedream's public catalog on 2026-10-06.
// Only reviewed actions are exposed; write actions still require Matrix approval.
export const OAUTH_SERVICE_REGISTRY: Record<string, ServiceDefinition> = {
  asana: service("asana", "Asana", "productivity", {
    list_workspaces: read("List a page of workspaces", `${asana}/workspaces`, [], { limitKey: "limit", cursorKey: "offset" }),
    list_projects: read("List a page of projects in a workspace", p => `${asana}/workspaces/${segment(p, "workspaceId")}/projects`, ["workspaceId"], { limitKey: "limit", cursorKey: "offset" }),
    list_tasks: read("List a page of tasks in a project", p => `${asana}/projects/${segment(p, "projectId")}/tasks`, ["projectId"], { limitKey: "limit", cursorKey: "offset" }),
  }),
  airtable: service("airtable", "Airtable", "productivity", {
    list_bases: read("List available bases; continue with offset", "https://api.airtable.com/v0/meta/bases", [], { cursorKey: "offset" }),
    list_tables: read("Read a base's table schema", p => `https://api.airtable.com/v0/meta/bases/${segment(p, "baseId")}/tables`, ["baseId"]),
    list_records: read("Read a page of table records", p => `https://api.airtable.com/v0/${segment(p, "baseId")}/${segment(p, "tableId")}`, ["baseId", "tableId"], { limitKey: "pageSize", cursorKey: "offset" }),
  }, "airtable_oauth"),
  clickup: service("clickup", "ClickUp", "productivity", {
    list_workspaces: read("List authorized workspaces", "https://api.clickup.com/api/v2/team"),
    get_task: read("Read a task by ID", p => `https://api.clickup.com/api/v2/task/${segment(p, "taskId")}`, ["taskId"]),
  }),
  todoist: service("todoist", "Todoist", "productivity", {
    ...TODOIST_DEPTH_ACTIONS,
    list_projects: read("Read a page of projects", `${todoist}/projects`, [], { limitKey: "limit", cursorKey: "cursor" }),
    list_tasks: read("Read a page of tasks", `${todoist}/tasks`, [], { limitKey: "limit", cursorKey: "cursor" }),
  }),
  dropbox: service("dropbox", "Dropbox", "files", {
    list_files: {
      description: "List root files and folders; continue with the returned cursor", risk: "read", params: {}, paramsSchema: z.object({}).strict(),
      directApi: { method: "POST", url: "https://api.dropboxapi.com/2/files/list_folder", mapBody: () => ({ path: "", limit: 100 }) },
    },
    list_files_continue: {
      description: "Read the next page of files", risk: "read", params: { cursor: { ...CURSOR, required: true } }, paramsSchema: z.object({ cursor: cursorSchema }).strict(),
      directApi: { method: "POST", url: "https://api.dropboxapi.com/2/files/list_folder/continue", mapBody: p => ({ cursor: p.cursor }) },
    },
  }),
  box: service("box", "Box", "files", {
    list_files: read("List root folder contents", "https://api.box.com/2.0/folders/0/items?usemarker=true", [], { limitKey: "limit", cursorKey: "marker" }),
    get_file: read("Read file details", p => `https://api.box.com/2.0/files/${segment(p, "fileId")}`, ["fileId"]),
  }),
  microsoft_outlook: service("microsoft_outlook", "Microsoft Outlook", "communication", {
    list_messages: read("Read a page of email messages", `${graph}/me/messages`, [], { limitKey: "$top", cursorKey: "$skip", cursorParam: "skip" }),
    list_folders: read("Read a page of mail folders", `${graph}/me/mailFolders`, [], { limitKey: "$top", cursorKey: "$skip", cursorParam: "skip" }),
  }),
  microsoft_onedrive: service("microsoft_onedrive", "Microsoft OneDrive", "files", {
    list_files: read("Read root folder contents", `${graph}/me/drive/root/children`, [], { limitKey: "$top", cursorKey: "$skiptoken", cursorParam: "skipToken" }),
    get_file: read("Read file details", p => `${graph}/me/drive/items/${segment(p, "fileId")}`, ["fileId"]),
  }),
  microsoft_teams: service("microsoft_teams", "Microsoft Teams", "communication", {
    list_teams: read("List teams you have joined", `${graph}/me/joinedTeams`),
    list_channels: read("Read a team's channels", p => `${graph}/teams/${segment(p, "teamId")}/channels`, ["teamId"]),
  }),
  hubspot: service("hubspot", "HubSpot", "sales", {
    ...HUBSPOT_DEPTH_ACTIONS,
    list_contacts: read("Read a page of CRM contacts", `${hubspot}/contacts`, [], { limitKey: "limit", cursorKey: "after" }),
    list_companies: read("Read a page of CRM companies", `${hubspot}/companies`, [], { limitKey: "limit", cursorKey: "after" }),
    list_deals: read("Read a page of CRM deals", `${hubspot}/deals`, [], { limitKey: "limit", cursorKey: "after" }),
  }),
  zoom: service("zoom", "Zoom", "communication", {
    list_meetings: read("Read a page of scheduled meetings", "https://api.zoom.us/v2/users/me/meetings", [], { limitKey: "page_size", cursorKey: "next_page_token" }),
    get_meeting: read("Read a meeting by ID", p => `https://api.zoom.us/v2/meetings/${segment(p, "meetingId")}`, ["meetingId"]),
  }),
  google_slides: service("google_slides", "Google Slides", "design", {
    get_presentation: read("Read presentation content", p => `https://slides.googleapis.com/v1/presentations/${segment(p, "presentationId")}`, ["presentationId"]),
    get_slide: read("Read a slide's content", p => `https://slides.googleapis.com/v1/presentations/${segment(p, "presentationId")}/pages/${segment(p, "pageId")}`, ["presentationId", "pageId"]),
  }),
};
