// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock gateway
vi.mock("../../../shell/src/lib/gateway.js", () => ({
  getGatewayUrl: () => "http://localhost:4000",
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { PublishDialog } from "../../../shell/src/components/app-store/PublishDialog.js";

describe("PublishDialog", () => {
  const defaultProps = {
    appSlug: "test-app",
    appName: "Test App",
    onClose: vi.fn(),
    onPublished: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it("renders the publish form", () => {
    render(<PublishDialog {...defaultProps} />);
    expect(screen.getByText("Publish Test App")).toBeDefined();
    expect(screen.getByPlaceholderText(/Brief description/)).toBeDefined();
    expect(screen.getByText("Publish")).toBeDefined();
  });

  it("validates required fields", async () => {
    render(<PublishDialog {...defaultProps} />);
    fireEvent.click(screen.getByText("Publish"));

    await waitFor(() => {
      expect(screen.getByText("Description is required")).toBeDefined();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("submits publish request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        listingId: "listing-1",
        versionId: "version-1",
        auditStatus: "passed",
        auditFindings: [],
        storeUrl: "/store/author/test-app",
      }),
    });

    render(<PublishDialog {...defaultProps} />);

    const descInput = screen.getByPlaceholderText(/Brief description/);
    fireEvent.change(descInput, { target: { value: "A great app" } });

    fireEvent.click(screen.getByText("Publish"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/api/apps/test-app/publish",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });

  it("shows audit results after publish", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        listingId: "listing-1",
        versionId: "version-1",
        auditStatus: "passed",
        auditFindings: [],
        storeUrl: "/store/author/test-app",
      }),
    });

    render(<PublishDialog {...defaultProps} />);

    const descInput = screen.getByPlaceholderText(/Brief description/);
    fireEvent.change(descInput, { target: { value: "A great app" } });

    fireEvent.click(screen.getByText("Publish"));

    await waitFor(() => {
      expect(screen.getByText("Verified")).toBeDefined();
    });
  });

  it("shows failed audit findings", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        listingId: "listing-1",
        versionId: "version-1",
        auditStatus: "failed",
        auditFindings: [
          { rule: "path-traversal", message: "Path traversal detected", severity: "error" },
        ],
        storeUrl: "/store/author/test-app",
      }),
    });

    render(<PublishDialog {...defaultProps} />);

    const descInput = screen.getByPlaceholderText(/Brief description/);
    fireEvent.change(descInput, { target: { value: "Bad app" } });

    fireEvent.click(screen.getByText("Publish"));

    await waitFor(() => {
      expect(screen.getByText("Audit failed")).toBeDefined();
      expect(screen.getByText(/path-traversal/)).toBeDefined();
    });
  });

  it("calls onClose when Cancel is clicked", () => {
    render(<PublishDialog {...defaultProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("handles network errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    render(<PublishDialog {...defaultProps} />);

    const descInput = screen.getByPlaceholderText(/Brief description/);
    fireEvent.change(descInput, { target: { value: "A great app" } });

    fireEvent.click(screen.getByText("Publish"));

    await waitFor(() => {
      expect(screen.getByText("Network error - please try again")).toBeDefined();
    });
  });
});
