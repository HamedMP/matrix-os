// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CollaborativeAppShareButton } from "../../packages/ui/src/collaboration/collaborative-app-sharing.js";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const readiness = {
  readinessId: "40000000-0000-4000-8000-000000000001",
  build: {
    appId: "team-tracker", catalogId: "30000000-0000-4000-8000-000000000001",
    registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
    manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
    bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
  },
  status: "ready" as const,
  revision: "2",
  checks: ["declaration", "exact_build", "owner_postgres", "recipient_launch", "participant_identity",
    "two_principal_round_trip", "idempotent_retry", "conflict_write", "change_signal", "provider_safety", "cleanup"]
    .map((code) => ({ code, status: "passed" as const })),
  verifiedAt: "2026-11-05T10:00:00.000Z",
};
const share = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  organizationId: "org_matrix_team",
  owner: { actorId: "user_owner", displayName: "Nima" }, build: readiness.build,
  readinessId: readiness.readinessId, state: "active" as const, shareRevision: "1", bindingRevision: "1",
  dataRevision: "0", createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z",
};

describe("collaborative app owner sharing controls", () => {
  it("confirms full access for every current member and creates from a fresh preflight", async () => {
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? readiness : null),
      post: vi.fn(async (path: string) => path.endsWith("/preflight") ? {
        eligible: true, catalogId: readiness.build.catalogId, resourceRevision: "0",
        readinessId: readiness.readinessId, buildId: readiness.build.buildId,
        confirmationToken: "token_payload.signature_value",
      } : share),
      delete: vi.fn(),
    };
    render(<CollaborativeAppShareButton appId="team-tracker" api={api}
      organizationId="org_matrix_team" organizationName="Matrix team" />);

    fireEvent.click(await screen.findByRole("button", { name: "Share app" }));
    expect(await screen.findByRole("dialog", { name: "Share Team tracker" })).toBeVisible();
    expect(screen.getAllByRole("combobox", { name: "Organization" })).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Organization" })).toHaveValue("org_matrix_team");
    expect(screen.getByText(/Everyone currently in Matrix team, including guests, gets full app access/)).toBeVisible();
    expect(screen.queryByText(/role|editor|viewer/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share with everyone" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith("/api/collaboration/apps/team-tracker/share", {
      organizationId: "org_matrix_team",
      clientRequestId: expect.any(String),
      expectedResourceRevision: "0",
      expectedReadinessRevision: "2",
      readinessId: readiness.readinessId,
      buildId: readiness.build.buildId,
      confirmationToken: "token_payload.signature_value",
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Shared with Matrix team");
  });

  it("stops using both current CAS revisions and leaves owner data untouched in the copy", async () => {
    const stopped = { ...share, state: "stopped" as const, shareRevision: "2", bindingRevision: "2" };
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? readiness : share),
      post: vi.fn(),
      delete: vi.fn(async () => stopped),
    };
    render(<CollaborativeAppShareButton appId="team-tracker" api={api}
      organizationId="org_matrix_team" organizationName="Matrix team" />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage app sharing" }));
    expect(await screen.findByText(/does not delete or change your app data/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/collaboration/apps/team-tracker/share", {
      clientRequestId: expect.any(String), expectedShareRevision: "1", expectedBindingRevision: "1",
    }));
    expect(await screen.findByText("Sharing stopped")).toBeVisible();
  });

  it("keeps stop-sharing available when the rebuilt app has no current readiness", async () => {
    const stopped = { ...share, state: "stopped" as const, shareRevision: "2", bindingRevision: "2" };
    const api = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? null : share),
      post: vi.fn(),
      delete: vi.fn(async () => stopped),
    };
    render(<CollaborativeAppShareButton appId="team-tracker" api={api}
      organizationId="org_matrix_team" organizationName="Matrix team" />);

    fireEvent.click(await screen.findByRole("button", { name: "Manage app sharing" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop sharing" }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledOnce());
  });
});
