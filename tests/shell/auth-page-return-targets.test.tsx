import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

// Fault detected: the Matrix sign-in and sign-up pages forced every
// non-Slack redirect_url to "/", so visitors from the ai-insights.app Clerk
// satellite were stranded in Matrix instead of being sent back.
vi.mock("@clerk/nextjs", () => ({
  SignIn: function SignIn() { return null; },
  SignUp: function SignUp() { return null; },
}));

const { default: SignInPage } = await import("../../shell/src/app/sign-in/[[...sign-in]]/page");
const { default: SignUpPage } = await import("../../shell/src/app/sign-up/[[...sign-up]]/page");

type RedirectProps = { forceRedirectUrl?: string; fallbackRedirectUrl?: string };

function clerkWidgetProps(tree: unknown): RedirectProps {
  if (!isValidElement(tree)) throw new Error("page did not return an element");
  const child = (tree as ReactElement<{ children: unknown }>).props.children;
  if (!isValidElement(child)) throw new Error("auth layout has no Clerk widget");
  const { forceRedirectUrl, fallbackRedirectUrl } = child.props as RedirectProps;
  return { forceRedirectUrl, fallbackRedirectUrl };
}

async function signInRedirect(redirectUrl?: string | string[]): Promise<RedirectProps> {
  const params = redirectUrl === undefined ? {} : { redirect_url: redirectUrl };
  return clerkWidgetProps(await SignInPage({ searchParams: Promise.resolve(params) }));
}

async function signUpRedirect(redirectUrl?: string | string[]): Promise<RedirectProps> {
  const params = redirectUrl === undefined ? {} : { redirect_url: redirectUrl };
  return clerkWidgetProps(await SignUpPage({ searchParams: Promise.resolve(params) }));
}

const satellite = "https://ai-insights.app/share?__clerk_synced=false#report=abc";
const gmailLink = `/auth/gmail?state=${"g".repeat(43)}`;
const slackLink = `/slack/link?token=${"a".repeat(43)}`;
const bypasses = [
  "https://ai-insights.app.evil.com/share",
  "https://ai-insights.app@evil.com/share",
  "http://ai-insights.app/share",
  "https://evil.example/steal",
  "//ai-insights.app/share",
];

describe("sign-in page return target", () => {
  it("returns a signed-out Gmail connection to its exact pending consent", async () => {
    expect(await signInRedirect(gmailLink)).toEqual({ forceRedirectUrl: gmailLink, fallbackRedirectUrl: gmailLink });
  });
  it.each([gmailLink + "&next=https://evil.test", gmailLink + "#other", "https://evil.test" + gmailLink,
    gmailLink + "&state=" + "x".repeat(43), "/auth/gmail?state=bad", "/auth/gmail?state=%2F"]) ("rejects malformed Gmail return %s", async target => {
    expect(await signInRedirect(target)).toEqual({ forceRedirectUrl: "/", fallbackRedirectUrl: "/" });
  });

  it("sends a satellite visitor back to the exact ai-insights.app page", async () => {
    expect(await signInRedirect(satellite)).toEqual({
      forceRedirectUrl: satellite,
      fallbackRedirectUrl: satellite,
    });
  });

  it("keeps the exact Slack link return unchanged", async () => {
    expect(await signInRedirect(slackLink)).toEqual({
      forceRedirectUrl: slackLink,
      fallbackRedirectUrl: slackLink,
    });
  });

  it.each(bypasses)("returns %s to the app root", async (value) => {
    expect(await signInRedirect(value)).toEqual({ forceRedirectUrl: "/", fallbackRedirectUrl: "/" });
  });

  it("returns a missing or repeated redirect_url to the app root", async () => {
    expect(await signInRedirect()).toEqual({ forceRedirectUrl: "/", fallbackRedirectUrl: "/" });
    expect(await signInRedirect([satellite, satellite]))
      .toEqual({ forceRedirectUrl: "/", fallbackRedirectUrl: "/" });
  });
});

describe("sign-up page return target", () => {
  it("sends a new satellite account back to the exact ai-insights.app page", async () => {
    expect(await signUpRedirect(satellite)).toEqual({
      forceRedirectUrl: satellite,
      fallbackRedirectUrl: satellite,
    });
  });

  it.each([...bypasses, slackLink])("returns %s to the app root", async (value) => {
    expect(await signUpRedirect(value)).toEqual({ forceRedirectUrl: "/", fallbackRedirectUrl: "/" });
  });

  it("returns a missing redirect_url to the app root", async () => {
    expect(await signUpRedirect()).toEqual({ forceRedirectUrl: "/", fallbackRedirectUrl: "/" });
  });
});
