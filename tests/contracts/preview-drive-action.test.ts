import { describe, expect, it } from "vitest";
import {
  canonicalPreviewDriveTurnBody,
  previewDriveActionCanonical,
} from "../../packages/contracts/src/index.js";

describe("Preview Drive canonical action", () => {
  it("returns one domain-separated canonical string regardless of object key order", () => {
    const expected = `matrix-preview-drive-action:v1\0${JSON.stringify(["google_drive", "list_files", "My Drive", 3])}`;
    expect(previewDriveActionCanonical({ service: "google_drive", action: "list_files", label: "My Drive", params: { maxResults: 3 } })).toBe(expected);
    expect(previewDriveActionCanonical({ params: { maxResults: 3 }, label: "My Drive", action: "list_files", service: "google_drive" })).toBe(expected);
  });

  it.each([
    { service: "google_drive", action: "get_file", label: "My Drive", params: { maxResults: 3 } },
    { service: "google_drive", action: "list_files", label: " ", params: { maxResults: 3 } },
    { service: "google_drive", action: "list_files", label: " My Drive ", params: { maxResults: 3 } },
    { service: "google_drive", action: "list_files", label: "a".repeat(101), params: { maxResults: 3 } },
    { service: "google_drive", action: "list_files", label: "My Drive", params: { maxResults: 0 } },
    { service: "google_drive", action: "list_files", label: "My Drive", params: { maxResults: 4 } },
    { service: "google_drive", action: "list_files", label: "My Drive", params: { maxResults: 1.5 } },
    { service: "google_drive", action: "list_files", label: "My Drive", params: { maxResults: 3, query: "secret" } },
    { service: "google_drive", action: "list_files", label: "My Drive", params: { maxResults: 3 }, actorId: "other" },
  ])("rejects any nonallowlisted action, label, parameter or field %#", input => {
    expect(previewDriveActionCanonical(input)).toBeNull();
  });
});

it("canonicalizes a validated Chat turn body for Platform and Gateway hashing", () => {
  const body = { clientRequestId: "req_drive", baseRevision: 0, parts: [{ type: "text", text: "List my files" }],
    selection: { instanceId: "claude_code_default", model: "claude-opus-5" }, interactionMode: "default", permissionMode: "supervised" };
  expect(canonicalPreviewDriveTurnBody(body)).toBe(JSON.stringify(body));
  expect(canonicalPreviewDriveTurnBody({ permissionMode: body.permissionMode, interactionMode: body.interactionMode,
    selection: body.selection, parts: body.parts, baseRevision: body.baseRevision,
    clientRequestId: body.clientRequestId })).toBe(JSON.stringify(body));
  expect(() => canonicalPreviewDriveTurnBody({ ...body, attacker: true })).toThrow();
});
