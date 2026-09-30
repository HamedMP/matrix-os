import { describe, expect, it } from "vitest";
import { parseCollaborationIdentityEnvironment } from "./collaboration-identities.js";

describe("collaboration journey environment", () => {
  const environment = {
    CLERK_SECRET_KEY: "sk_test_fixture",
    COLLABORATION_E2E_ALLOWED_USER_IDS: "user_owner,user_member,user_outsider,user_guest",
    COLLABORATION_E2E_ORGANIZATION_ID: "org_fixture",
    COLLABORATION_E2E_OWNER_USER_ID: "user_owner",
    COLLABORATION_E2E_MEMBER_USER_ID: "user_member",
    COLLABORATION_E2E_OUTSIDER_USER_ID: "user_outsider",
    COLLABORATION_E2E_GUEST_USER_ID: "user_guest",
    PREVIEW_COLLABORATION_OWNER_USER_ID: "user_owner",
    MATRIX_COLLABORATION_E2E_BASE_URL: "https://preview.matrix-os.com",
    COLLABORATION_E2E_PREVIEW_PR_NUMBER: "1991",
  };

  it("derives only the reviewed platform origin and exact preview route", () => {
    expect(parseCollaborationIdentityEnvironment(environment)).toMatchObject({
      baseUrl: "https://preview.matrix-os.com",
      previewHandle: "pr-1991",
      organizationId: "org_fixture",
    });
    expect(() => parseCollaborationIdentityEnvironment({ ...environment, MATRIX_COLLABORATION_E2E_BASE_URL: "https://review-vm.matrix-os.com" })).toThrow();
    expect(() => parseCollaborationIdentityEnvironment({ ...environment, COLLABORATION_E2E_PREVIEW_PR_NUMBER: "../owner" })).toThrow();
  });
});
