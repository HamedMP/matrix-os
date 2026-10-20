import { z } from "zod/v4";
import { ID, NUMERIC_ID, optional, segment, strictFields, text, type CatalogField } from "./catalog-fields.js";
import type { ServiceAction } from "./types.js";

// Official contracts: developers.asana.com/reference/{createtask,updatetask},
// developer.clickup.com/reference/{createtask,updatetask},
// airtable.com/developers/web/api/{create-records,update-record}, and
// developers.hubspot.com/docs/api-reference/legacy/crm/objects/{contacts,companies,deals}.
// All mutations retain the existing approval path and selected-account proxy.
const name: CatalogField = { ...text(500), schema: z.string().min(1).max(500).refine(value => value.trim().length > 0) };
const longText: CatalogField = { schema: z.string().max(10000), param: { type: "string", maxLength: 10000 } };
const boolean: CatalogField = { schema: z.boolean(), param: { type: "boolean" } };
const dueOn: CatalogField = { schema: z.iso.date().nullable(), param: { type: "string", description: "YYYY-MM-DD, or null to clear the due date" } };
const dueDate: CatalogField = { schema: z.number().int().min(0).max(8640000000000000), param: { type: "number", minimum: 0, maximum: 8640000000000000, description: "Unix timestamp in milliseconds" } };
const priority: CatalogField = { schema: z.number().int().min(1).max(4), param: { type: "number", minimum: 1, maximum: 4 } };
const nonempty = (params: Record<string, unknown>) => Object.values(params).some(value => value !== undefined);
const paramsFor = (fields: Record<string, CatalogField>) => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.param]));
function mapped(params: Record<string, unknown>, fields: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => params[key] !== undefined).map(([key, apiKey]) => [apiKey, params[key]]));
}
function write(description: string, fields: Record<string, CatalogField>, api: NonNullable<ServiceAction["directApi"]>, updateId?: string): ServiceAction {
  const schema = strictFields(fields);
  return { description, risk: "write", params: paramsFor(fields),
    paramsSchema: updateId ? schema.refine(params => nonempty(Object.fromEntries(Object.entries(params).filter(([key]) => key !== updateId)))) : schema,
    directApi: api };
}

const asanaUrl = "https://app.asana.com/api/1.0/tasks";
const asanaFields = { name: optional(name), notes: optional(longText), completed: optional(boolean), dueOn: optional(dueOn) };
const asanaBody = (params: Record<string, unknown>) => ({ data: mapped(params, { name: "name", notes: "notes", completed: "completed", dueOn: "due_on", workspaceId: "workspace", projectIds: "projects" }) });
const asana: Record<string, ServiceAction> = {
  create_task: write("Create one Asana task in a workspace after approval; requires tasks:write", {
    ...asanaFields, workspaceId: NUMERIC_ID, name,
    projectIds: optional({ schema: z.array(NUMERIC_ID.schema).min(1).max(20), param: { type: "array", description: "Up to 20 project IDs in the selected workspace" } }),
  }, { method: "POST", url: asanaUrl, mapBody: asanaBody }),
  update_task: write("Update supplied Asana task fields after approval; requires tasks:write", { taskId: NUMERIC_ID, ...asanaFields },
    { method: "PUT", url: params => `${asanaUrl}/${segment(params, "taskId", NUMERIC_ID)}`, mapBody: asanaBody }, "taskId"),
};

const airtableId = (prefix: string) => text(17, new RegExp(`^${prefix}[A-Za-z0-9]{14}$`));
const baseId = airtableId("app"); const tableId = airtableId("tbl"); const recordId = airtableId("rec");
const cell = z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null(), z.array(z.string().max(4096)).max(100)]);
const fieldKey = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const airtableFields: CatalogField = {
  schema: z.record(fieldKey, cell).refine(fields => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 50)
    .refine(fields => Buffer.byteLength(JSON.stringify(fields), "utf8") <= 64 * 1024),
  param: { type: "object", required: true, description: "1–50 fields by name/ID, at most 64 KiB; scalar values or up to 100 strings per array. No attachment/collaborator objects or automatic type conversion." },
};
const airtableUrl = (params: Record<string, unknown>) => `https://api.airtable.com/v0/${segment(params, "baseId", baseId)}/${segment(params, "tableId", tableId)}`;
const airtableBody = (params: Record<string, unknown>) => ({ fields: params.fields, typecast: false });
const airtable: Record<string, ServiceAction> = {
  create_record: write("Create one Airtable record after approval; requires data.records:write and base editor access", { baseId, tableId, fields: airtableFields },
    { method: "POST", url: airtableUrl, mapBody: airtableBody }),
  update_record: write("Patch supplied Airtable cell values after approval; omitted fields remain unchanged", { baseId, tableId, recordId, fields: airtableFields },
    { method: "PATCH", url: params => `${airtableUrl(params)}/${segment(params, "recordId", recordId)}`, mapBody: airtableBody }),
};

const clickupFields = { name: optional(name), description: optional(longText), status: optional(text(128)), priority: optional(priority), dueDate: optional(dueDate) };
const clickupBody = (params: Record<string, unknown>) => mapped(params, { name: "name", description: "description", status: "status", priority: "priority", dueDate: "due_date" });
const clickupUrl = "https://api.clickup.com/api/v2";
const clickup: Record<string, ServiceAction> = {
  create_task: write("Create one ClickUp task after approval; enforce the list's required custom fields", { listId: NUMERIC_ID, ...clickupFields, name },
    { method: "POST", url: params => `${clickupUrl}/list/${segment(params, "listId", NUMERIC_ID)}/task`, mapBody: params => ({ ...clickupBody(params), check_required_custom_fields: true }) }),
  update_task: write("Update supplied ClickUp task fields after approval using its native task ID", { taskId: ID, ...clickupFields },
    { method: "PUT", url: params => `${clickupUrl}/task/${segment(params, "taskId")}`, mapBody: clickupBody }, "taskId"),
};

const shortString = z.string().max(500);
const optionalString = shortString.optional();
const email = z.email().max(254);
const domain = z.string().min(1).max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/);
const pipelineId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const money = z.string().max(32).regex(/^\d{1,20}(?:\.\d{1,6})?$/);
const contactProperties = { email: email.optional(), firstname: optionalString, lastname: optionalString, phone: z.string().max(64).optional(), company: optionalString };
const companyProperties = { name: optionalString, domain: domain.optional(), phone: z.string().max(64).optional(), description: z.string().max(10000).optional(), city: optionalString, country: optionalString };
const dealProperties = { dealname: optionalString, pipeline: pipelineId.optional(), dealstage: pipelineId.optional(), amount: money.optional(), closedate: z.iso.datetime({ offset: true }).optional(), description: z.string().max(10000).optional() };
const hubspotUrl = "https://api.hubapi.com/crm/v3/objects";
function crmWrite(object: string, schema: z.ZodType, description: string, idName?: string): ServiceAction {
  const fields: Record<string, CatalogField> = { ...(idName ? { [idName]: NUMERIC_ID } : {}), properties: { schema, param: { type: "object", required: true, description } } };
  return write(`${idName ? "Update supplied" : "Create one"} HubSpot ${object} record after approval; requires matching CRM write scope`, fields,
    { method: idName ? "PATCH" : "POST", url: params => `${hubspotUrl}/${object}${idName ? `/${segment(params, idName, NUMERIC_ID)}` : ""}`, mapBody: params => ({ properties: params.properties }) });
}
const hubspot: Record<string, ServiceAction> = {
  create_contact: crmWrite("contacts", z.strictObject({ ...contactProperties, email }), "email (required), firstname, lastname, phone, company"),
  update_contact: crmWrite("contacts", z.strictObject(contactProperties).refine(nonempty), "At least one of email, firstname, lastname, phone, company; empty name, phone, or company text clears that value", "contactId"),
  create_company: crmWrite("companies", z.strictObject({ ...companyProperties, name: name.schema }), "name (required), domain, phone, description, city, country"),
  update_company: crmWrite("companies", z.strictObject(companyProperties).refine(nonempty), "At least one of name, domain, phone, description, city, country", "companyId"),
  create_deal: crmWrite("deals", z.strictObject({ ...dealProperties, dealname: name.schema, pipeline: pipelineId, dealstage: pipelineId }), "dealname, pipeline, dealstage (required); amount as decimal string, closedate as ISO timestamp, description"),
  update_deal: crmWrite("deals", z.strictObject(dealProperties).refine(nonempty), "At least one of dealname, pipeline, dealstage, amount as decimal string, closedate as ISO timestamp, description", "dealId"),
};

/** Parent registry composes these actions into existing services; grants are never expanded here. */
export const TASK_CRM_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = { asana, airtable, clickup, hubspot };
