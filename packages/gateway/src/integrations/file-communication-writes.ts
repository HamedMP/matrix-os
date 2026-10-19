import { z } from "zod/v4";
import { ID, NUMERIC_ID, choice, integer, optional, segment, strictFields, type CatalogField } from "./catalog-fields.js";
import { boundedWrite, email, folderName, nonblank, phone, utcDateTime } from "./bounded-writes.js";
import type { ServiceAction } from "./types.js";

// Official contracts:
// https://dropbox.github.io/dropbox-sdk-js/Dropbox.html#filesCreateFolderV2__anchor
// https://developer.box.com/reference/post-folders/
// https://developers.zoom.us/docs/api/meetings/ (Create a meeting)
// https://developers.intercom.com/docs/references/2.14/rest-api/api.intercom.io/contacts/createcontact
// https://developers.intercom.com/docs/references/2.14/rest-api/api.intercom.io/contacts/updatecontact
const dropboxPath: CatalogField = {
  schema: z.string().min(2).max(1024).startsWith("/").refine(path => path.slice(1).split("/").every(part => folderName.schema.safeParse(part).success)),
  param: { type: "string", required: true, minLength: 2, maxLength: 1024, description: "Absolute folder path with no empty, dot or parent components" },
};
const contactFields = { name: optional(nonblank(200)), email: optional(email), phone: optional(phone) };
const intercomHeaders = { "Intercom-Version": "2.14" };
export const FILE_COMMUNICATION_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = {
  dropbox: {
    create_folder: boundedWrite("Create one folder after approval; fail on name conflict", { path: dropboxPath },
      { method: "POST", url: "https://api.dropboxapi.com/2/files/create_folder_v2", mapBody: p => ({ path: p.path, autorename: false }) }),
  },
  box: {
    create_folder: boundedWrite("Create one folder under the selected parent after approval", { parentFolderId: NUMERIC_ID, name: folderName },
      { method: "POST", url: "https://api.box.com/2.0/folders", mapBody: p => ({ name: p.name, parent: { id: p.parentFolderId } }) }),
  },
  zoom: {
    create_meeting: boundedWrite("Create a scheduled meeting for your connected account after approval", { topic: nonblank(200), startTime: utcDateTime, duration: integer(1, 1440) }, {
      method: "POST", url: "https://api.zoom.us/v2/users/me/meetings",
      mapBody: p => ({ topic: p.topic, type: 2, start_time: p.startTime, timezone: "UTC", duration: p.duration }),
    }),
  },
  intercom: {
    create_contact: boundedWrite("Create one contact with an email address after approval", { role: choice(["lead", "user"]), email, name: optional(nonblank(200)) }, {
      method: "POST", url: "https://api.intercom.io/contacts", staticHeaders: intercomHeaders,
      mapBody: p => ({ role: p.role, email: p.email, ...(p.name !== undefined ? { name: p.name } : {}) }),
    }),
    update_contact: boundedWrite("Update explicitly supplied contact fields after approval", { contactId: ID, ...contactFields }, {
      method: "PUT", url: p => `https://api.intercom.io/contacts/${segment(p, "contactId")}`, staticHeaders: intercomHeaders,
      mapBody: p => ({ ...(p.name !== undefined ? { name: p.name } : {}), ...(p.email !== undefined ? { email: p.email } : {}), ...(p.phone !== undefined ? { phone: p.phone } : {}) }),
    }, strictFields({ contactId: ID, ...contactFields }).refine(p => p.name !== undefined || p.email !== undefined || p.phone !== undefined)),
  },
};
