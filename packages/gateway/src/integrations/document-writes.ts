import { z } from "zod/v4";
import { ID, optional, segment, text, type CatalogField } from "./catalog-fields.js";
import { boundedWrite, email, nonblank, phone } from "./bounded-writes.js";
import type { ServiceAction } from "./types.js";

// Official contracts: https://developers.google.com/people/api/rest/v1/people/createContact
// https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/create
// https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request
const slides = "https://slides.googleapis.com/v1/presentations";
const objectId: CatalogField = {
  schema: z.string().min(5).max(50).regex(/^[A-Za-z0-9_][A-Za-z0-9_:-]*$/),
  param: { type: "string", required: true, minLength: 5, maxLength: 50 },
};
// Existing Google-assigned IDs can be shorter than the 5-character minimum
// for caller-created objects (for example an initial slide can have ID "p").
// The end-of-input assertion also rejects trailing newlines.
const existingPageId: CatalogField = {
  schema: z.string().min(1).max(256).regex(/^[A-Za-z0-9_][A-Za-z0-9_:-]*(?![\s\S])/),
  param: { type: "string", required: true, minLength: 1, maxLength: 256 },
};
const replacement: CatalogField = { schema: z.string().max(10000), param: { type: "string", required: true, maxLength: 10000 } };
export const DOCUMENT_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = {
  google_contacts: {
    create_contact: boundedWrite("Create one contact after approval", {
      givenName: nonblank(200), familyName: optional(nonblank(200)), email: optional(email), phone: optional(phone),
    }, {
      method: "POST", url: "https://people.googleapis.com/v1/people:createContact?personFields=names,emailAddresses,phoneNumbers,metadata",
      mapBody: p => ({
        names: [{ givenName: p.givenName, ...(p.familyName !== undefined ? { familyName: p.familyName } : {}) }],
        ...(p.email !== undefined ? { emailAddresses: [{ value: p.email }] } : {}),
        ...(p.phone !== undefined ? { phoneNumbers: [{ value: p.phone }] } : {}),
      }),
    }),
  },
  google_slides: {
    create_presentation: boundedWrite("Create a blank named presentation after approval", { title: nonblank(200) },
      { method: "POST", url: slides, mapBody: p => ({ title: p.title }) }),
    add_slide: boundedWrite("Add one blank slide with an explicit unique object ID after approval", { presentationId: ID, slideId: objectId }, {
      method: "POST", url: p => `${slides}/${segment(p, "presentationId")}:batchUpdate`,
      mapBody: p => ({ requests: [{ createSlide: { objectId: p.slideId, slideLayoutReference: { predefinedLayout: "BLANK" } } }] }),
    }),
    replace_slide_text: boundedWrite("Replace literal case-sensitive text on one slide after approval", {
      presentationId: ID, pageId: existingPageId, findText: text(1000), replaceText: replacement,
    }, {
      method: "POST", url: p => `${slides}/${segment(p, "presentationId")}:batchUpdate`,
      mapBody: p => ({ requests: [{ replaceAllText: { containsText: { text: p.findText, matchCase: true }, replaceText: p.replaceText, pageObjectIds: [p.pageId] } }] }),
    }),
  },
};
