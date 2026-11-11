/**
 * Stable identities for the collaborative-app production journeys.
 * Authentication material is supplied by the live test environment; this
 * fixture deliberately does not invent the deferred second readiness principal.
 */
export const collaborativeAppSharingFixture = Object.freeze({
  organization: Object.freeze({
    id: "org_collaborative_apps",
    wrongOrganizationId: "org_unrelated",
  }),
  tracker: Object.freeze({
    appId: "team-tracker",
    catalogId: "50000000-0000-4000-8000-000000000001",
    registrationIncarnation: "b".repeat(64),
    buildId: "a".repeat(64),
    existingTaskCount: 20,
  }),
  actors: Object.freeze({
    owner: Object.freeze({ actorId: "user_tracker_owner", organizationRole: "member", membership: "current" }),
    member: Object.freeze({ actorId: "user_tracker_member", organizationRole: "member", membership: "current" }),
    guest: Object.freeze({ actorId: "user_tracker_guest", organizationRole: "guest", membership: "current" }),
    newcomer: Object.freeze({ actorId: "user_tracker_newcomer", organizationRole: "member", membership: "new" }),
    departedMember: Object.freeze({ actorId: "user_tracker_departed", organizationRole: "member", membership: "departed" }),
    wrongOrganizationMember: Object.freeze({ actorId: "user_wrong_organization", organizationRole: "member", membership: "wrong_organization" }),
    outsider: Object.freeze({ actorId: "user_tracker_outsider", organizationRole: "none", membership: "none" }),
  }),
  readiness: Object.freeze({
    secondPrincipalCredentialSource: null,
    expectedStatusUntilConfigured: "blocked",
  }),
});

export type CollaborativeAppSharingFixture = typeof collaborativeAppSharingFixture;
