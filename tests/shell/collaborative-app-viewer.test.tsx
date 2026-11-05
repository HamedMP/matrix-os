// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";

const mocks = vi.hoisted(() => ({
  createApi: vi.fn(),
  releaseApi: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("@/hooks/useBrowserOrigin", () => ({ useBrowserOrigin: () => "https://app.matrix-os.test" }));
vi.mock("@/lib/collaboration", () => ({
  createShellCollaborationApi: mocks.createApi,
  releaseShellCollaborationApi: mocks.releaseApi,
}));
vi.mock("@matrix-os/ui/collaborative-app-sharing", () => ({
  CollaborativeAppShareButton: () => null,
  ReadinessSummary: () => null,
  useCollaborativeAppSharing: () => ({ readiness: null }),
  createSharedAppTransport: mocks.createTransport,
  SharedAppViewer: ({ target }: { target: CollaborativeAppDirectoryItem }) => (
    <div data-testid="shared-app-viewer">{target.scopeId}</div>
  ),
}));
vi.mock("@/api/http", () => ({ shellApi: {} }));
vi.mock("@/lib/collaboration-organization-state", () => ({
  useCollaborationOrganization: () => ({ organizationId: null, organizationName: null }),
}));

import { AppViewer } from "../../shell/src/components/AppViewer.js";
import {
  sharedAppDeepLink,
  sharedAppWindowPath,
  sharedAppWindowTitle,
} from "../../shell/src/lib/shared-app-target.js";

const target: CollaborativeAppDirectoryItem = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  runtimeId: "vps:20000000-0000-4000-8000-000000000001",
  organizationId: "org_matrix_team",
  authorityGeneration: 1,
  appId: "tracker",
  catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: "1",
  owner: { actorId: "user_owner", displayName: "Nima" },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("collaborative app web viewer", () => {
  it("derives one stable window identity and an exact-build fallback link", () => {
    expect(sharedAppWindowPath(target)).toBe(`__shared-app__:${target.scopeId}`);
    expect(sharedAppWindowTitle(target)).toBe("Tracker shared by Nima");
    expect(sharedAppDeepLink(target)).toBe(
      `/shared/app/${target.scopeId}?expectedBuildId=${target.buildId}&expectedShareRevision=1`,
    );
  });

  it("routes an exact shared target through the restricted shared transport, never the owner bridge", () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn(), close: vi.fn() };
    const api = { direct };
    const transport = { target };
    mocks.createApi.mockReturnValue(api);
    mocks.createTransport.mockReturnValue(transport);

    const view = render(
      <AppViewer path={`__shared-app__:${target.scopeId}`} sharedAppTarget={target} />,
    );

    expect(screen.getByTestId("shared-app-viewer").textContent).toBe(target.scopeId);
    expect(mocks.createApi).toHaveBeenCalledWith("https://app.matrix-os.test");
    expect(mocks.createTransport).toHaveBeenCalledWith({ platform: api, direct, target });

    view.unmount();
    expect(mocks.releaseApi).toHaveBeenCalledWith(api);
  });
});
