// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../../../shell/src/lib/gateway.js", () => ({
  getGatewayUrl: () => "http://localhost:4000",
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { ReviewSection } from "../../../shell/src/components/app-store/ReviewSection.js";

describe("ReviewSection", () => {
  const defaultProps = {
    listingId: "listing-1",
    authorId: "author-1",
    isInstalled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        reviews: [],
        total: 0,
        averageRating: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      }),
    });
  });

  it("renders ratings header", async () => {
    render(<ReviewSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Ratings & Reviews")).toBeDefined();
    });
  });

  it("shows empty state when no reviews", async () => {
    render(<ReviewSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/No reviews yet/)).toBeDefined();
    });
  });

  it("shows sign in message when no user", async () => {
    render(<ReviewSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Sign in to leave a review/)).toBeDefined();
    });
  });

  it("shows install message when not installed", async () => {
    render(<ReviewSection {...defaultProps} currentUserId="user-1" isInstalled={false} />);
    await waitFor(() => {
      expect(screen.getByText(/Install this app to leave a review/)).toBeDefined();
    });
  });

  it("shows review form when installed and authenticated", async () => {
    render(<ReviewSection {...defaultProps} currentUserId="user-1" isInstalled={true} />);
    await waitFor(() => {
      expect(screen.getByText("Write a review")).toBeDefined();
      expect(screen.getByText("Submit Review")).toBeDefined();
    });
  });

  it("fetches and displays reviews", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviews: [
          {
            id: "review-1",
            reviewer_id: "user-2",
            rating: 4,
            body: "Great app!",
            author_response: null,
            author_responded_at: null,
            flagged: false,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
        averageRating: 4.0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 },
      }),
    });

    render(<ReviewSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Great app!")).toBeDefined();
    });
  });

  it("shows author response when present", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviews: [
          {
            id: "review-1",
            reviewer_id: "user-2",
            rating: 5,
            body: "Love it",
            author_response: "Thanks for the kind words!",
            author_responded_at: "2026-01-02T00:00:00Z",
            flagged: false,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
        averageRating: 5.0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
      }),
    });

    render(<ReviewSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Developer Response")).toBeDefined();
      expect(screen.getByText("Thanks for the kind words!")).toBeDefined();
    });
  });

  it("shows respond button for listing author", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviews: [
          {
            id: "review-1",
            reviewer_id: "user-2",
            rating: 3,
            body: "Could be better",
            author_response: null,
            author_responded_at: null,
            flagged: false,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
        averageRating: 3.0,
        distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
      }),
    });

    render(
      <ReviewSection
        {...defaultProps}
        currentUserId="author-1"
        isInstalled={true}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Respond")).toBeDefined();
    });
  });

  it("displays rating distribution bars", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        reviews: [],
        total: 0,
        averageRating: 4.0,
        distribution: { 1: 2, 2: 1, 3: 5, 4: 10, 5: 20 },
      }),
    });

    render(<ReviewSection {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("4.0")).toBeDefined();
      expect(screen.getByText("38 ratings")).toBeDefined();
    });
  });
});
