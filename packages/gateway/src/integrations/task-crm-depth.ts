import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const content = z.string().min(1).max(500).refine((value) => value.trim().length > 0);
const taskFields = { content: content.optional(), description: z.string().max(10000).optional(), priority: z.number().int().min(1).max(4).optional(), dueDate: z.iso.date().optional() };
const params = { content: { type: "string" as const }, description: { type: "string" as const }, priority: { type: "number" as const }, dueDate: { type: "string" as const } };
const body = (p: Record<string, unknown>) => ({
  ...(p.content !== undefined ? { content: p.content } : {}),
  ...(p.description !== undefined ? { description: p.description } : {}),
  ...(p.priority !== undefined ? { priority: p.priority } : {}),
  ...(p.dueDate !== undefined ? { due_date: p.dueDate } : {}),
  ...(p.projectId !== undefined ? { project_id: p.projectId } : {}),
});
const todoist = "https://api.todoist.com/api/v1/tasks";
export const TODOIST_DEPTH_ACTIONS: Record<string, ServiceAction> = {
  get_task: { description: "Read one task", risk: "read", params: { taskId: { type: "string", required: true } }, paramsSchema: z.strictObject({ taskId: id }), directApi: { method: "GET", url: (p) => `${todoist}/${id.parse(p.taskId)}` } },
  create_task: {
    description: "Create one task after approval", risk: "write",
    params: { ...params, content: { type: "string", required: true }, projectId: { type: "string" } },
    paramsSchema: z.strictObject({ ...taskFields, content, projectId: id.optional() }),
    directApi: { method: "POST", url: todoist, mapBody: body },
  },
  update_task: {
    description: "Update explicitly supplied task fields after approval", risk: "write", params: { ...params, taskId: { type: "string", required: true } },
    paramsSchema: z.strictObject({ taskId: id, ...taskFields }).refine((p) => Object.keys(p).length > 1),
    directApi: { method: "POST", url: (p) => `${todoist}/${id.parse(p.taskId)}`, mapBody: body },
  },
  complete_task: {
    description: "Complete one task after approval", risk: "write", params: { taskId: { type: "string", required: true } }, paramsSchema: z.strictObject({ taskId: id }),
    directApi: { method: "POST", url: (p) => `${todoist}/${id.parse(p.taskId)}/close`, mapBody: () => ({}) },
  },
};

const properties = z.array(z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/)).min(1).max(30).optional();
const hubspot = "https://api.hubapi.com/crm/v3/objects";
function record(object: string, idName: string): ServiceAction {
  return { description: `Read a CRM ${object} record with selected properties`, risk: "read",
    params: { [idName]: { type: "string", required: true }, properties: { type: "array" } }, paramsSchema: z.strictObject({ [idName]: z.string().min(1).max(32).regex(/^\d+$/), properties }),
    directApi: { method: "GET", url: (p) => `${hubspot}/${object}/${encodeURIComponent(String(p[idName]))}`, mapParams: (p): Record<string, string> => Array.isArray(p.properties) ? { properties: p.properties.join(",") } : {} },
  };
}
const activity = z.enum(["notes", "calls", "emails", "meetings", "tasks"]);
export const HUBSPOT_DEPTH_ACTIONS: Record<string, ServiceAction> = {
  get_contact: record("contacts", "contactId"), get_company: record("companies", "companyId"), get_deal: record("deals", "dealId"),
  list_activities: {
    description: "Read one page of a selected CRM activity type; choose body properties explicitly", risk: "read",
    params: { activityType: { type: "string", required: true }, properties: { type: "array" }, limit: { type: "number" }, cursor: { type: "string" } },
    paramsSchema: z.strictObject({ activityType: activity, properties, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional() }),
    directApi: { method: "GET", url: (p) => `${hubspot}/${activity.parse(p.activityType)}`, mapParams: (p) => ({ limit: String(p.limit ?? 25), ...(p.cursor ? { after: String(p.cursor) } : {}), ...(Array.isArray(p.properties) ? { properties: p.properties.join(",") } : {}) }) },
  },
};
