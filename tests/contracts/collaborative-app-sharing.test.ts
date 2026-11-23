import {
  CollaborativeAppBuildRefSchema,
  CollaborativeAppCapabilityDeclarationSchema,
  CollaborativeAppChangeSignalSchema,
  CollaborativeAppCompatibilityDeclarationSchema,
  CollaborativeAppLaunchTargetSchema,
  CollaborativeAppLaunchRequestSchema,
  CollaborativeAppLaunchResponseSchema,
  CollaborativeAppManifestDeclarationSchema,
  CollaborativeAppMutationRequestSchema,
  CollaborativeAppMutationResponseSchema,
  CollaborativeAppParticipantSchema,
  CollaborativeAppReadinessGateResultSchema,
  CollaborativeAppReadinessSchema,
  CollaborativeAppSafeErrorSchema,
  CollaborativeAppShareSchema,
  CollaborativeAppDirectoryItemSchema,
  CollaborationDirectoryEventSchema,
  COLLABORATIVE_APP_ICON_MAX_BYTES,
  collaborativeAppIconPath,
  sniffCollaborativeAppIconContentType,
} from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";

const scopeId = "10000000-0000-4000-8000-000000000001";
const readinessId = "20000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const eventId = "40000000-0000-4000-8000-000000000001";
const catalogId = "50000000-0000-4000-8000-000000000001";
const organizationId = "org_2abcDEF123";
const now = "2026-11-05T10:00:00.000Z";
const digest = "a".repeat(64);

const build = {
  appId: "team-tracker",
  catalogId,
  registrationIncarnation: "b".repeat(64),
  manifestVersion: "1.4.0",
  buildId: digest,
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};

const owner = { actorId: "user_owner", displayName: "App Owner" };

describe("collaborative app sharing contracts", () => {
  it("serializes an exact immutable build reference and rejects drift-prone or secret fields", () => {
    expect(CollaborativeAppBuildRefSchema.parse(build)).toEqual(build);
    for (const invalid of [
      { ...build, buildId: "not-a-digest" },
      { ...build, registrationIncarnation: "mutable-slug" },
      { ...build, manifestVersion: "v".repeat(129) },
      { ...build, ownerPath: "/home/matrix/apps/team-tracker" },
      { ...build, providerToken: "secret" },
    ]) {
      expect(CollaborativeAppBuildRefSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts only bounded readiness gates and enforces ready and invalidated invariants", () => {
    const ready = {
      readinessId,
      build,
      status: "ready",
      revision: "3",
      checks: [
        { code: "declaration", status: "passed" },
        { code: "recipient_launch", status: "passed" },
        { code: "cleanup", status: "passed" },
      ],
      verifiedAt: now,
    };
    expect(CollaborativeAppReadinessSchema.parse(ready)).toEqual(ready);
    expect(CollaborativeAppReadinessSchema.parse({
      ...ready,
      status: "checking",
      checks: [],
      verifiedAt: undefined,
    })).toMatchObject({ status: "checking", checks: [] });
    expect(CollaborativeAppReadinessSchema.parse({
      ...ready,
      status: "blocked",
      verifiedAt: undefined,
      checks: [{ code: "declaration", status: "blocked", action: "Declare collaborative capability." }],
    }).status).toBe("blocked");
    expect(CollaborativeAppReadinessSchema.parse({
      ...ready,
      status: "failed",
      verifiedAt: undefined,
      checks: [{ code: "cleanup", status: "failed", action: "Clean up the verifier data and retry." }],
    }).status).toBe("failed");

    for (const invalid of [
      { ...ready, verifiedAt: undefined },
      { ...ready, checks: [{ code: "declaration", status: "failed" }] },
      { ...ready, status: "stale" },
      { ...ready, status: "blocked", verifiedAt: undefined, checks: [] },
      { ...ready, status: "failed", verifiedAt: undefined, checks: [{ code: "cleanup", status: "passed" }] },
      { ...ready, checks: Array.from({ length: 13 }, () => ({ code: "cleanup", status: "passed" })) },
      { ...ready, checks: [{ code: "cleanup", status: "blocked", action: "x".repeat(257) }] },
      { ...ready, checks: [{ code: "raw_sql", status: "failed" }] },
      { ...ready, rawError: "postgres connection refused" },
    ]) {
      expect(CollaborativeAppReadinessSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps legacy two-principal readiness blockers readable after the verifier upgrade", () => {
    expect(CollaborativeAppReadinessGateResultSchema.parse({
      code: "two_principal_round_trip",
      status: "blocked",
      action: "A second authenticated verifier is not configured yet.",
    })).toMatchObject({ code: "two_principal_round_trip", status: "blocked" });
  });

  it("serializes an owner-retained organization share without roles, grants, or acceptance", () => {
    const share = {
      scopeId,
      organizationId,
      owner,
      build,
      readinessId,
      state: "active",
      shareRevision: "2",
      dataRevision: "7",
      bindingRevision: "3",
      createdAt: now,
      updatedAt: now,
    };
    expect(CollaborativeAppShareSchema.parse(share)).toEqual(share);
    for (const forbidden of [
      { role: "editor" },
      { preset: "contributor" },
      { grantId: requestId },
      { invitationId: requestId },
      { acceptedAt: now },
      { recordFilter: { assignedTo: "user_member" } },
      { organizationAdminApproved: true },
    ]) {
      expect(CollaborativeAppShareSchema.safeParse({ ...share, ...forbidden }).success).toBe(false);
    }
  });

  it("keeps owner and shared launch targets as a strict discriminated union", () => {
    const ownerTarget = { kind: "owner", slug: "team-tracker", registrationIncarnation: "b".repeat(64) };
    const sharedTarget = {
      kind: "shared",
      scopeId,
      organizationId,
      appId: build.appId,
      catalogId,
      buildId: digest,
      name: "Team Tracker",
      iconUrl: "/api/apps/team-tracker/icon",
      owner,
      shareRevision: "2",
    };
    expect(CollaborativeAppLaunchTargetSchema.parse(ownerTarget)).toEqual(ownerTarget);
    expect(CollaborativeAppLaunchTargetSchema.parse(sharedTarget)).toEqual(sharedTarget);
    expect(CollaborativeAppLaunchTargetSchema.safeParse({ ...sharedTarget, slug: "team-tracker" }).success).toBe(false);
    expect(CollaborativeAppLaunchTargetSchema.safeParse({ ...ownerTarget, scopeId }).success).toBe(false);
    expect(CollaborativeAppLaunchTargetSchema.safeParse({ ...sharedTarget, ownerToken: "secret" }).success).toBe(false);
    expect(CollaborativeAppLaunchTargetSchema.safeParse({ ...sharedTarget, iconUrl: "https://evil.example/icon" }).success).toBe(false);
    for (const iconUrl of ["//evil.example/icon", "/unsafe\\icon", "/unsafe\0icon", "/./icon", "/../icon"]) {
      expect(CollaborativeAppLaunchTargetSchema.safeParse({ ...sharedTarget, iconUrl }).success).toBe(false);
    }
    expect(CollaborativeAppLaunchTargetSchema.parse({ ...sharedTarget, iconUrl: "/icon?v=1#safe" }).iconUrl)
      .toBe("/icon?v=1#safe");
    const launch = {
      target: sharedTarget,
      launchId: requestId,
      entryUrl: `/api/collaboration/shared-apps/${scopeId}/runtime/${requestId}/index.html`,
      expiresAt: now,
    };
    expect(CollaborativeAppLaunchRequestSchema.parse({
      clientRequestId: requestId,
      expectedShareRevision: "2",
      expectedBuildId: digest,
    })).toMatchObject({ expectedBuildId: digest });
    expect(CollaborativeAppLaunchResponseSchema.parse(launch)).toEqual(launch);
    expect(CollaborativeAppLaunchResponseSchema.safeParse({ ...launch, entryUrl: "https://owner.invalid/index.html" }).success)
      .toBe(false);
    expect(CollaborativeAppLaunchResponseSchema.safeParse({ ...launch, ownerCredential: "secret" }).success)
      .toBe(false);
  });

  it("carries an optional bounded owner name and a scope-confined versioned icon path in directory items", () => {
    const item = {
      scopeId,
      runtimeId: "runtime_owner",
      organizationId,
      authorityGeneration: 1,
      appId: build.appId,
      catalogId,
      readinessId,
      registrationIncarnation: "b".repeat(64),
      buildId: digest,
      shareRevision: "2",
      owner,
    };
    // Backwards compatible: older platforms omit both fields.
    expect(CollaborativeAppDirectoryItemSchema.parse(item)).toEqual(item);
    const iconUrl = collaborativeAppIconPath(scopeId, "f".repeat(64));
    expect(iconUrl).toBe(`/api/collaboration/shared-apps/${scopeId}/icon?v=${"f".repeat(64)}`);
    const decorated = { ...item, name: "Team Tracker", iconUrl };
    expect(CollaborativeAppDirectoryItemSchema.parse(decorated)).toEqual(decorated);
    for (const invalid of [
      `/icons/${build.appId}.png`,
      "https://evil.example/icon.png",
      `/api/collaboration/shared-apps/${eventId}/icon?v=${"f".repeat(64)}`,
      `/api/collaboration/shared-apps/${scopeId}/icon`,
      `/api/collaboration/shared-apps/${scopeId}/icon?v=nothex`,
    ]) {
      expect(CollaborativeAppDirectoryItemSchema.safeParse({ ...item, iconUrl: invalid }).success).toBe(false);
    }
    for (const name of ["", "   ", "x".repeat(121), "see /home/matrix/secret"]) {
      expect(CollaborativeAppDirectoryItemSchema.safeParse({ ...item, name }).success).toBe(false);
    }
  });

  it("adds optional owner presentation to directory app metadata without accepting secrets", () => {
    const event = {
      eventId,
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: "user_owner",
      kind: "app",
      organizationId,
      audience: "current_membership",
      app: {
        appId: build.appId,
        catalogId,
        readinessId,
        registrationIncarnation: "b".repeat(64),
        buildId: digest,
        shareRevision: 2,
        state: "active",
      },
      authorityGeneration: 1,
      metadataRevision: 2,
      recipients: [],
    };
    expect(CollaborationDirectoryEventSchema.parse(event)).toEqual(event);
    const presented = { ...event, app: { ...event.app, name: "Team Tracker", iconSha256: "f".repeat(64) } };
    expect(CollaborationDirectoryEventSchema.parse(presented)).toEqual(presented);
    const thumbnail = { sha256: "f".repeat(64), contentType: "image/png", base64: Buffer.alloc(48 * 1024).toString("base64") };
    const complete = { ...event, runtimeId: "r".repeat(128), ownerId: "o".repeat(128), organizationId: `org_${"g".repeat(124)}`,
      recipients: Array.from({ length: 8 }, () => ({ actorId: "a".repeat(128), status: "accepted", invitationId: eventId, grantId: eventId })),
      app: { ...event.app, appId: "a".repeat(256), name: "界".repeat(120), thumbnail },
    };
    expect(CollaborationDirectoryEventSchema.safeParse(complete).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThan(96 * 1024);
    expect(CollaborationDirectoryEventSchema.parse({ ...event, app: { ...event.app, thumbnail: { ...thumbnail, base64: "!bad" } } }).app?.thumbnail)
      .toBeUndefined();

    for (const app of [
      { ...event.app, iconSha256: "not-a-digest" },
      { ...event.app, name: "x".repeat(121) },
      { ...event.app, iconUrl: "https://owner.invalid/icon.png" },
    ]) {
      expect(CollaborationDirectoryEventSchema.safeParse({ ...event, app }).success).toBe(false);
    }
  });

  it("sniffs only bounded raster icon bytes and never SVG or HTML", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    const webp = new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ");
    expect(sniffCollaborativeAppIconContentType(png)).toBe("image/png");
    expect(sniffCollaborativeAppIconContentType(jpeg)).toBe("image/jpeg");
    expect(sniffCollaborativeAppIconContentType(webp)).toBe("image/webp");
    for (const invalid of [
      new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
      new TextEncoder().encode("<!doctype html><script>alert(1)</script>"),
      new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WAVEfmt "),
      png.slice(0, 7),
      new Uint8Array(),
    ]) {
      expect(sniffCollaborativeAppIconContentType(invalid)).toBeNull();
    }
    const oversized = new Uint8Array(COLLABORATIVE_APP_ICON_MAX_BYTES + 1);
    oversized.set(png);
    expect(sniffCollaborativeAppIconContentType(oversized)).toBeNull();
  });

  it("bounds participant identity to display context without membership or credential claims", () => {
    const participant = {
      actorId: "user_member",
      displayName: "Current Member",
      organizationId,
      scopeId,
      shareRevision: "2",
      buildId: digest,
    };
    expect(CollaborativeAppParticipantSchema.parse(participant)).toEqual(participant);
    for (const forbidden of [
      { membershipProof: "signed" },
      { directSessionKey: "secret" },
      { ownerCookie: "secret" },
      { providerToken: "secret" },
      { canWrite: true },
    ]) {
      expect(CollaborativeAppParticipantSchema.safeParse({ ...participant, ...forbidden }).success).toBe(false);
    }
  });

  it("bounds mutation JSON and requires revisioned idempotency", () => {
    const mutation = {
      clientRequestId: requestId,
      expectedRevision: "7",
      action: { type: "update", table: "tasks", id: "task-1", data: { title: "Done" } },
    };
    expect(CollaborativeAppMutationRequestSchema.parse(mutation)).toEqual(mutation);
    expect(CollaborativeAppMutationResponseSchema.parse({ result: { ok: true }, revision: "8", replayed: false })).toEqual({
      result: { ok: true }, revision: "8", replayed: false,
    });
    expect(CollaborativeAppMutationRequestSchema.safeParse({ ...mutation, expectedRevision: 7 }).success).toBe(false);
    expect(CollaborativeAppMutationRequestSchema.safeParse({ ...mutation, action: { type: "update", data: "x".repeat(65 * 1024) } }).success).toBe(false);
    expect(CollaborativeAppMutationRequestSchema.safeParse({ ...mutation, payloadHash: digest }).success).toBe(false);
    expect(CollaborativeAppMutationResponseSchema.safeParse({ result: { token: BigInt(1) }, revision: "8", replayed: false }).success).toBe(false);
  });

  it("uses content-free bounded change signals", () => {
    const changed = {
      type: "resource.app.changed",
      eventId,
      scopeSequence: "11",
      scopeId,
      appId: build.appId,
      buildId: digest,
      revision: "8",
      occurredAt: now,
    };
    expect(CollaborativeAppChangeSignalSchema.parse(changed)).toEqual(changed);
    for (const type of ["share.access_ended", "share.needs_recheck", "refresh_required"]) {
      expect(CollaborativeAppChangeSignalSchema.parse({ ...changed, type }).type).toBe(type);
    }
    expect(CollaborativeAppChangeSignalSchema.safeParse({ ...changed, records: [{ id: "task-1" }] }).success).toBe(false);
    expect(CollaborativeAppChangeSignalSchema.safeParse({ ...changed, type: "task.updated" }).success).toBe(false);
  });

  it("allows only closed safe client errors", () => {
    expect(CollaborativeAppSafeErrorSchema.parse({
      code: "needs_recheck",
      safeMessage: "This app needs another readiness check.",
      retryable: false,
    }).code).toBe("needs_recheck");
    for (const invalid of [
      { code: "postgres_error", safeMessage: "Try again.", retryable: true },
      { code: "unavailable", safeMessage: "postgres relation tasks missing", retryable: true },
      { code: "unavailable", safeMessage: "x".repeat(181), retryable: true },
      { code: "unavailable", safeMessage: "Try again.", retryable: true, rawError: "secret" },
    ]) {
      expect(CollaborativeAppSafeErrorSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("freezes exact-build capability and compatibility declarations", () => {
    const capability = {
      version: 1,
      storage: "owner_postgres",
      audience: "current_organization_members",
      participantIdentity: "authenticated_actor",
      mutations: "transactional_revisioned",
      updates: "content_free_signal",
      providerPolicy: "existing_authority",
    };
    const compatibility = {
      bridgeContractVersion: build.bridgeContractVersion,
      runtimeAbi: build.runtimeAbi,
      schemaDigest: build.schemaDigest,
    };
    expect(CollaborativeAppCapabilityDeclarationSchema.parse(capability)).toEqual(capability);
    expect(CollaborativeAppCompatibilityDeclarationSchema.parse(compatibility)).toEqual(compatibility);
    expect(CollaborativeAppManifestDeclarationSchema.parse({ capability, compatibility })).toEqual({ capability, compatibility });
    expect(CollaborativeAppCapabilityDeclarationSchema.safeParse({ ...capability, audience: "selected_members" }).success).toBe(false);
    expect(CollaborativeAppCapabilityDeclarationSchema.safeParse({ ...capability, appRoles: ["editor"] }).success).toBe(false);
    expect(CollaborativeAppCompatibilityDeclarationSchema.safeParse({ ...compatibility, runtimeAbi: "" }).success).toBe(false);
    expect(CollaborativeAppManifestDeclarationSchema.safeParse({ capability, compatibility, readiness: "ready" }).success).toBe(false);
  });
});
