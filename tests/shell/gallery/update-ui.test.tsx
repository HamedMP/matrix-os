// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../../shell/src/lib/gateway.js", () => ({
  getGatewayUrl: () => "http://localhost:4000",
}));

import { UpdateBadge } from "../../../shell/src/components/app-store/UpdateBadge.js";
import { AppDetail } from "../../../shell/src/components/app-store/AppDetail.js";
import type { AppStoreEntry } from "../../../shell/src/stores/app-store.js";

describe("UpdateBadge", () => {
  it("renders version transition", () => {
    render(
      <UpdateBadge installedVersion="1.0.0" currentVersion="2.0.0" />,
    );
    expect(screen.getByText(/1\.0\.0/)).toBeDefined();
    expect(screen.getByText(/2\.0\.0/)).toBeDefined();
  });
});

describe("AppDetail with updates", () => {
  const baseEntry: AppStoreEntry = {
    id: "test-1",
    name: "Test App",
    description: "A test app",
    category: "utility",
    author: "author-1",
    source: "gallery",
    slug: "test-app",
    listingId: "listing-1",
    version: "2.0.0",
  };

  it("shows update badge when update is available", () => {
    render(
      <AppDetail
        entry={baseEntry}
        installed={true}
        updateInfo={{ installedVersion: "1.0.0", currentVersion: "2.0.0", hasUpdate: true }}
        onClose={() => {}}
        onInstall={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.getByText(/Update to 2\.0\.0/)).toBeDefined();
    expect(screen.getByText(/1\.0\.0/)).toBeDefined();
  });

  it("shows update button when update is available", () => {
    render(
      <AppDetail
        entry={baseEntry}
        installed={true}
        updateInfo={{ installedVersion: "1.0.0", currentVersion: "2.0.0", hasUpdate: true }}
        onClose={() => {}}
        onInstall={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.getByText(/Update to 2\.0\.0/)).toBeDefined();
  });

  it("shows rollback button when handler is provided", () => {
    render(
      <AppDetail
        entry={baseEntry}
        installed={true}
        updateInfo={{ installedVersion: "1.0.0", currentVersion: "2.0.0", hasUpdate: true }}
        onClose={() => {}}
        onInstall={() => {}}
        onUpdate={() => {}}
        onRollback={() => {}}
      />,
    );
    expect(screen.getByText("Rollback")).toBeDefined();
  });

  it("calls onUpdate when update button is clicked", () => {
    const onUpdate = vi.fn();
    render(
      <AppDetail
        entry={baseEntry}
        installed={true}
        updateInfo={{ installedVersion: "1.0.0", currentVersion: "2.0.0", hasUpdate: true }}
        onClose={() => {}}
        onInstall={() => {}}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByText(/Update to 2\.0\.0/));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("does not show update UI when no update available", () => {
    render(
      <AppDetail
        entry={baseEntry}
        installed={true}
        updateInfo={{ installedVersion: "2.0.0", currentVersion: "2.0.0", hasUpdate: false }}
        onClose={() => {}}
        onInstall={() => {}}
        onUpdate={() => {}}
      />,
    );
    expect(screen.queryByText(/Update to/)).toBeNull();
  });
});
