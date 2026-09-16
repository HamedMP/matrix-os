import { describe, expect, it } from "vitest";
import { parseCollaborationJourneyEnvironment } from "./collaboration.js";

describe("two-account collaboration journey fixture", () => {
  it("builds supported session-routed URLs without exposing storage-state paths", () => {
    expect(parseCollaborationJourneyEnvironment({
      PATH: "/usr/bin",
      MATRIX_COLLABORATION_E2E_BASE_URL: "https://app.matrix-os.com",
      MATRIX_COLLABORATION_E2E_RUNTIME_HANDLE: "review-vm",
      MATRIX_COLLABORATION_E2E_OWNER_STATE: "/tmp/owner.json",
      MATRIX_COLLABORATION_E2E_EDITOR_STATE: "/tmp/editor.json",
      MATRIX_COLLABORATION_E2E_PROJECT_ID: "proj_review",
      MATRIX_COLLABORATION_E2E_EDITOR_ACTOR_ID: "user_editor",
    })).toEqual({
      baseUrl: "https://app.matrix-os.com",
      runtimePath: "/vm/review-vm",
      ownerStorageState: "/tmp/owner.json",
      editorStorageState: "/tmp/editor.json",
      projectId: "proj_review",
      editorActorId: "user_editor",
    });
  });

  it("rejects per-handle subdomains and unsafe runtime handles", () => {
    expect(() => parseCollaborationJourneyEnvironment({
      MATRIX_COLLABORATION_E2E_BASE_URL: "https://review-vm.matrix-os.com",
      MATRIX_COLLABORATION_E2E_RUNTIME_HANDLE: "review-vm",
      MATRIX_COLLABORATION_E2E_OWNER_STATE: "/tmp/owner.json",
      MATRIX_COLLABORATION_E2E_EDITOR_STATE: "/tmp/editor.json",
      MATRIX_COLLABORATION_E2E_PROJECT_ID: "proj_review",
      MATRIX_COLLABORATION_E2E_EDITOR_ACTOR_ID: "user_editor",
    })).toThrow();
    expect(() => parseCollaborationJourneyEnvironment({
      MATRIX_COLLABORATION_E2E_BASE_URL: "https://app.matrix-os.com",
      MATRIX_COLLABORATION_E2E_RUNTIME_HANDLE: "../owner",
      MATRIX_COLLABORATION_E2E_OWNER_STATE: "/tmp/owner.json",
      MATRIX_COLLABORATION_E2E_EDITOR_STATE: "/tmp/editor.json",
      MATRIX_COLLABORATION_E2E_PROJECT_ID: "proj_review",
      MATRIX_COLLABORATION_E2E_EDITOR_ACTOR_ID: "user_editor",
    })).toThrow();
  });
});
