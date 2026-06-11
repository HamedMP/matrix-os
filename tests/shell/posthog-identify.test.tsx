// @vitest-environment jsdom

import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true as boolean,
  user: {
    id: "user_2abcDEF",
    username: "neo" as string | null,
    primaryEmailAddress: { emailAddress: "neo@example.com" } as { emailAddress: string } | null,
  } as {
    id: string;
    username: string | null;
    primaryEmailAddress: { emailAddress: string } | null;
  } | null,
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    user: clerkState.user,
  }),
}));

const posthogClientMock = vi.hoisted(() => ({
  identifyPostHogUser: vi.fn(),
  resetPostHogIdentity: vi.fn(),
}));

vi.mock("@/lib/posthog-client", () => posthogClientMock);

import { PostHogIdentify } from "@/components/PostHogIdentify";

describe("PostHogIdentify", () => {
  beforeEach(() => {
    posthogClientMock.identifyPostHogUser.mockReset();
    posthogClientMock.resetPostHogIdentity.mockReset();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.user = {
      id: "user_2abcDEF",
      username: "neo",
      primaryEmailAddress: { emailAddress: "neo@example.com" },
    };
  });

  it("identifies the signed-in Clerk user with email and username", () => {
    render(<PostHogIdentify />);

    expect(posthogClientMock.identifyPostHogUser).toHaveBeenCalledTimes(1);
    expect(posthogClientMock.identifyPostHogUser).toHaveBeenCalledWith("user_2abcDEF", {
      email: "neo@example.com",
      username: "neo",
    });
    expect(posthogClientMock.resetPostHogIdentity).not.toHaveBeenCalled();
  });

  it("resets identity when the visitor is signed out", () => {
    clerkState.isSignedIn = false;
    clerkState.user = null;

    render(<PostHogIdentify />);

    expect(posthogClientMock.identifyPostHogUser).not.toHaveBeenCalled();
    expect(posthogClientMock.resetPostHogIdentity).toHaveBeenCalledTimes(1);
  });

  it("does nothing while Clerk is still loading", () => {
    clerkState.isLoaded = false;

    render(<PostHogIdentify />);

    expect(posthogClientMock.identifyPostHogUser).not.toHaveBeenCalled();
    expect(posthogClientMock.resetPostHogIdentity).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    const { container } = render(<PostHogIdentify />);
    expect(container.innerHTML).toBe("");
  });
});
