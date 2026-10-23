import { describe, expect, it } from "vitest";
import {
  SiteDeploymentSchema, SitePublishingSchema, SiteSlugSchema,
  SiteSubmissionCursorSchema, SiteSubmissionsQuerySchema, validateSiteForm, SiteOwnerMutationSchema, SiteSubmitCapabilitySchema, SiteRecordSchema,
} from "../../packages/contracts/src/sites.js";

describe("public site contracts", () => {
  const form = { id: "rsvp", title: "RSVP", fields: {
    email: { type: "email" as const, required: true },
    guests: { type: "number" as const, min: 1, max: 5 },
    consent: { type: "boolean" as const, required: true },
  } };
  it("defaults to no public data or forms", () => {
    expect(SitePublishingSchema.parse({})).toEqual({ data: {}, forms: [] });
  });
  it("accepts named exact form fields and rejects private or malformed payloads", () => {
    const declared = SitePublishingSchema.parse({ forms: [form] }).forms[0]!;
    expect(validateSiteForm(declared, { email: "visitor@example.com", consent: false }).success).toBe(true);
    for (const input of [{ email: "bad", consent: true }, { email: "visitor@example.com" },
      { email: "visitor@example.com", consent: true, ownerId: "someone" },
      { email: "visitor@example.com", consent: true, guests: 6 }]) {
      expect(validateSiteForm(declared, input).success).toBe(false);
    }
  });
  it("bounds forms, requires unique IDs and coherent numeric limits", () => {
    expect(SitePublishingSchema.safeParse({ forms: [form, form] }).success).toBe(false);
    expect(SitePublishingSchema.safeParse({ forms: [{ ...form, fields: { n: { type: "number", min: 4, max: 1 } } }] }).success).toBe(false);
    expect(SitePublishingSchema.safeParse({ data: { value: "x".repeat(65_537) } }).success).toBe(false);
  });
  it("reserves routes and distinguishes slug identifiers", () => {
    expect(SiteSlugSchema.parse("matrix-launch")).toBe("matrix-launch");
    for (const value of ["api", "public", "assets", "_matrix", "../secret", "MixedCase", "a".repeat(64), "550e8400-e29b-41d4-a716-446655440000"]) {
      expect(SiteSlugSchema.safeParse(value).success).toBe(false);
    }
  });
  it("accepts only bounded deployable assets and public metadata", () => {
    const deploy = { title: "Launch", config: {}, files: [{ path: "index.html", contentType: "text/html", body: "PGgxPkxhdW5jaDwvaDE+" }] };
    expect(SiteDeploymentSchema.parse(deploy).files).toHaveLength(1);
    for (const path of ["../index.html", "/index.html", "a/../../private", ".env", "main.js.map", "a\\b.js", "a/%2e%2e/x", "source.ts"]) {
      expect(SiteDeploymentSchema.safeParse({ ...deploy, files: [{ ...deploy.files[0], path }] }).success).toBe(false);
    }
    expect(SiteDeploymentSchema.safeParse({ ...deploy, files: [deploy.files[0], deploy.files[0]] }).success).toBe(false);
    expect(SiteOwnerMutationSchema.safeParse({ title: "Launch", ownerId: "another" }).success).toBe(false);
  });
  it("accepts a valid large asset without overflowing the validator", () => {
    const files = [
      { path: "index.html", contentType: "text/html", body: "" },
      { path: "assets/model.wasm", contentType: "application/wasm", body: Buffer.alloc(8 * 1024 * 1024).toString("base64") },
    ];
    expect(SiteDeploymentSchema.safeParse({ title: "Large app", config: {}, files }).success).toBe(true);
    files[1]!.body = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    expect(SiteDeploymentSchema.safeParse({ title: "Too large", config: {}, files }).success).toBe(false);
  });
  it("retains exact base64 length, alphabet and terminal padding validation", () => {
    const deploy = (body: string) => SiteDeploymentSchema.safeParse({ title: "App", config: {}, files: [{ path: "index.html", contentType: "text/html", body }] }).success;
    for (const valid of ["", "Zg==", "Zm8=", "Zm9v", "AA+/", "Zm9vYg=="]) expect(deploy(valid), valid).toBe(true);
    for (const invalid of ["Z", "Zg=", "Zg===", "Z=g=", "=m9v", "Zm=v", "====", "Zg==\n", "Zm9_", "Zm9-"]) expect(deploy(invalid), invalid).toBe(false);
  });
  it("binds a submit capability to a version and immutable declared configuration", () => {
    const capability = { siteId: "550e8400-e29b-41d4-a716-446655440000", appSlug: "launch", versionId: "550e8400-e29b-41d4-a716-446655440001", config: { forms: [form] }, formId: "rsvp", fields: { email: "v@example.com", consent: true }, idempotencyKey: "550e8400e29b41d4a716446655440000" };
    expect(SiteSubmitCapabilitySchema.safeParse(capability).success).toBe(true);
    expect(SiteSubmitCapabilitySchema.safeParse({ ...capability, ownerId: "other" }).success).toBe(false);
  });
  it("allows publication links only on the fixed sites origin with a valid path", () => {
    const record = { id: "550e8400-e29b-41d4-a716-446655440000", appSlug: "launch", title: "Launch", description: "", slug: "matrix-launch", revision: 1, status: "published", activeVersion: null, versions: [], config: {} };
    expect(SiteRecordSchema.safeParse({ ...record, url: "https://matrix.page/matrix-launch" }).success).toBe(true);
    for (const url of ["javascript:alert(1)", "https://evil.example/matrix-launch", "https://matrix.page@evil.example/matrix-launch", "http://matrix.page/matrix-launch", "https://matrix.page/api", "https://matrix.page/matrix-launch?token=secret"]) {
      expect(SiteRecordSchema.safeParse({ ...record, url }).success).toBe(false);
    }
  });
  it("validates bounded exact keyset cursors and rejects offset or malformed cursors", () => {
    const cursor="2026-10-09T12:00:00.123456Z|550e8400-e29b-41d4-a716-446655440000";
    expect(SiteSubmissionCursorSchema.parse(cursor)).toBe(cursor);
    expect(SiteSubmissionsQuerySchema.parse({})).toEqual({limit:50});
    expect(SiteSubmissionsQuerySchema.parse({limit:"100",cursor})).toEqual({limit:100,cursor});
    for(const value of ["50","",cursor+"x",cursor.replace("123456","123"),cursor.replace("10-09","13-99"),"x".repeat(1000)])expect(SiteSubmissionCursorSchema.safeParse(value).success).toBe(false);
    expect(SiteSubmissionsQuerySchema.safeParse({limit:101}).success).toBe(false);
  });

});
