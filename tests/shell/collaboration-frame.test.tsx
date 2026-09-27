// @vitest-environment jsdom

import React, { type ReactElement, type ReactNode } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationApi } from "@matrix-os/ui";

const scopeId = "10000000-0000-4000-8000-000000000001";
const otherScopeId = "10000000-0000-4000-8000-000000000002";
const origin = "http://localhost:3000";

const surface = vi.hoisted(() => ({ platform: true }));
const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  userId: "user_member" as string | null,
  signOut: vi.fn(async () => undefined),
  openUserProfile: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ push: vi.fn(), pathname: "/shared" }));
const apiState = vi.hoisted(() => ({ fake: null as CollaborationApi | null }));
const replaceMock = vi.hoisted(() => vi.fn());

vi.mock("../../shell/src/lib/shell-surface", () => ({
  isPlatformShellSurface: vi.fn(async () => surface.platform),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => navigation.pathname,
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: clerkState.isLoaded, isSignedIn: clerkState.isSignedIn, userId: clerkState.userId }),
  useUser: () => ({
    isLoaded: clerkState.isLoaded,
    user: clerkState.isSignedIn
      ? { fullName: "Mina Member", username: "mina", imageUrl: "", primaryEmailAddress: { emailAddress: "mina@example.com" } }
      : null,
  }),
  useClerk: () => ({ signOut: clerkState.signOut, openUserProfile: clerkState.openUserProfile }),
  SignIn: (props: Record<string, unknown>) => <div data-testid="clerk-sign-in" data-props={JSON.stringify(props)} />,
  SignUp: (props: Record<string, unknown>) => <div data-testid="clerk-sign-up" data-props={JSON.stringify(props)} />,
}));
vi.mock("@clerk/ui/themes", () => ({ shadcn: {} }));
vi.mock("../../shell/src/lib/collaboration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shell/src/lib/collaboration")>();
  return {
    ...actual,
    createShellCollaborationApi: vi.fn((baseUrl: string) => apiState.fake ?? actual.createShellCollaborationApi(baseUrl)),
    closeShellCollaborationSessions: vi.fn(actual.closeShellCollaborationSessions),
  };
});

import SharedPage from "../../shell/src/app/shared/page";
import SharedChatPage from "../../shell/src/app/shared/chat/[scopeId]/page";
import SharedTerminalPage from "../../shell/src/app/shared/terminal/[scopeId]/page";
import SharedInvitationPage from "../../shell/src/app/shared/invitations/[invitationId]/page";
import SharedProjectPage from "../../shell/src/app/shared/project/[scopeId]/page";
import { CollaborationFrame } from "../../shell/src/components/collaboration/CollaborationFrame";
import { ShellClerkAuth } from "../../shell/src/components/auth/ShellClerkAuth";
import { closeShellCollaborationSessions } from "../../shell/src/lib/collaboration";

const FORBIDDEN_PATHS = [
  /^\/api\/system\/info/,
  /^\/api\/journey/,
  /^\/api\/settings/,
  /^\/api\/layout/,
  /^\/api\/shell\//,
  /^\/api\/theme/,
  /^\/api\/terminal/,
  /^\/api\/auth\/ws-token/,
  /^\/api\/auth\/provision-runtime/,
  /^\/api\/billing/,
  /^\/billing\//,
  /^\/files\//,
  /^\/apps/,
  /^\/ws/,
  /^\/gateway\//,
];

function componentNames(node: ReactNode): string[] {
  if (!React.isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const type = element.type;
  const name = typeof type === "string" ? type : type.displayName ?? type.name;
  return [name, ...React.Children.toArray(element.props.children).flatMap(componentNames)];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordFetches(handler: (url: URL, init?: RequestInit) => Response = () => jsonResponse({ items: [] })) {
  const requests: Array<{ path: string; method: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), origin);
    requests.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET" });
    return handler(url, init);
  });
  return requests;
}

function expectOnlyCollaborationRequests(requests: Array<{ path: string; method: string }>) {
  for (const request of requests) {
    expect(FORBIDDEN_PATHS.some((pattern) => pattern.test(request.path)), request.path).toBe(false);
    expect(
      request.path.startsWith("/api/collaboration/")
        || (request.path === "/api/auth/app-session" && request.method === "DELETE"),
      request.path,
    ).toBe(true);
  }
}

const capabilities = {
  read: true,
  discuss: true,
  manageMembers: false,
  requestAi: false,
  observeTerminal: false,
  controlTerminal: false,
  stopTerminal: false,
};
const acceptedChat = {
  scopeId,
  runtimeId: "vps:11111111-1111-4111-8111-111111111111",
  ownerId: "user_owner",
  kind: "chat",
  authorityGeneration: 1,
  status: "accepted",
  resource: {
    scope: {
      id: scopeId,
      ownerId: "user_owner",
      kind: "chat",
      resourceId: "chat_shared",
      membershipMode: "direct",
      lifecycle: "shared",
      revision: "1",
      authEpoch: "1",
      authorityGeneration: "1",
      role: "editor",
      capabilities,
    },
    chat: { id: "chat_shared", scopeId, title: "Launch plan", lifecycle: "active", revision: "1", messageCount: "0" },
  },
};

function fakeApi(discovery: { inbox?: unknown; shared?: unknown; fail?: boolean }): CollaborationApi {
  return {
    baseUrl: origin,
    get: vi.fn(async (path: string) => {
      if (discovery.fail) throw new Error("CollaborationUnavailable");
      if (path.startsWith("/api/collaboration/inbox")) return discovery.inbox ?? { items: [] };
      if (path.startsWith("/api/collaboration/shared")) return discovery.shared ?? { items: [] };
      if (path.includes("/chat/messages")) return { messages: [] };
      if (path.endsWith("/chat")) return acceptedChat.resource.chat;
      return acceptedChat.resource.scope;
    }),
    post: vi.fn(async () => { throw new Error("CollaborationUnavailable"); }),
    patch: vi.fn(async () => ({ readThroughSeq: "0", pinned: false, muted: false })),
    delete: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as CollaborationApi;
}

beforeEach(() => {
  surface.platform = true;
  clerkState.isLoaded = true;
  clerkState.isSignedIn = true;
  clerkState.userId = "user_member";
  clerkState.signOut.mockClear();
  clerkState.openUserProfile.mockClear();
  navigation.push.mockClear();
  navigation.pathname = "/shared";
  apiState.fake = null;
  replaceMock.mockReset();
  vi.mocked(closeShellCollaborationSessions).mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin, href: `${origin}/shared`, pathname: "/shared", search: "", replace: replaceMock },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("shared pages select the shell surface", () => {
  const pages = [
    { name: "home", render: () => SharedPage(), vps: ["OnboardingGate", "ShellHome"] },
    { name: "chat", render: () => SharedChatPage({ params: Promise.resolve({ scopeId }) }), vps: ["OnboardingGate", "ShellHome"] },
    { name: "terminal", render: () => SharedTerminalPage({ params: Promise.resolve({ scopeId }) }), vps: ["OnboardingGate", "ShellHome"] },
    { name: "invitation", render: () => SharedInvitationPage({ params: Promise.resolve({ invitationId: scopeId }) }), vps: ["OnboardingGate", "ShellHome"] },
    { name: "project", render: () => SharedProjectPage({ params: Promise.resolve({ scopeId }) }), vps: ["CollaborationPage"] },
  ];

  it.each(pages)("renders the collaboration frame for $name on the platform surface", async ({ render: renderPage }) => {
    surface.platform = true;
    const names = componentNames(await renderPage());
    expect(names).toContain("CollaborationFrame");
    expect(names).not.toContain("OnboardingGate");
    expect(names).not.toContain("ShellHome");
    expect(names).not.toContain("BootSequence");
  });

  it.each(pages)("keeps the full OS composition for $name on a customer computer", async ({ render: renderPage, vps }) => {
    surface.platform = false;
    const names = componentNames(await renderPage());
    for (const name of vps) expect(names).toContain(name);
    expect(names).not.toContain("CollaborationFrame");
  });

  it("validates route parameters before choosing a surface", async () => {
    for (const platform of [true, false]) {
      surface.platform = platform;
      await expect(SharedChatPage({ params: Promise.resolve({ scopeId: "../../x" }) })).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(SharedTerminalPage({ params: Promise.resolve({ scopeId: "not-a-scope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(SharedInvitationPage({ params: Promise.resolve({ invitationId: "x" }) })).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(SharedProjectPage({ params: Promise.resolve({ scopeId: "../../api/x" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("passes the validated destination to the frame", async () => {
    const page = await SharedChatPage({ params: Promise.resolve({ scopeId }) }) as ReactElement<{ view: unknown }>;
    expect(page.props.view).toEqual({ kind: "chat", scopeId });
  });
});

describe("shell surface marker", () => {
  it("reads the process marker, not the request", async () => {
    const { isPlatformShellSurface } = await vi.importActual<typeof import("../../shell/src/lib/shell-surface")>(
      "../../shell/src/lib/shell-surface",
    );
    vi.stubEnv("MATRIX_SHELL_SURFACE", "platform");
    await expect(isPlatformShellSurface()).resolves.toBe(true);
    vi.stubEnv("MATRIX_SHELL_SURFACE", "vps");
    await expect(isPlatformShellSurface()).resolves.toBe(false);
    vi.stubEnv("MATRIX_SHELL_SURFACE", "");
    await expect(isPlatformShellSurface()).resolves.toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("CollaborationFrame", () => {
  it("renders Shared with me with frame chrome and only collaboration requests", async () => {
    const requests = recordFetches();

    render(<CollaborationFrame view={{ kind: "home" }} />);

    expect(await screen.findByText("Nothing shared yet")).toBeVisible();
    expect(screen.getByRole("link", { name: "Get a Matrix computer" })).toHaveAttribute("href", "/?billing=setup");
    expect(screen.getByRole("heading", { name: "Shared with me" })).toBeVisible();
    for (const nav of screen.getAllByRole("navigation")) {
      expect(within(nav).getByRole("link", { name: /Shared with me/ })).toHaveAttribute("aria-current", "page");
    }
    expect(screen.getByRole("button", { name: "Account menu for Mina Member" })).toBeVisible();
    expect(screen.queryByText("Choose your plan")).toBeNull();
    await waitFor(() => expect(requests.map((request) => request.path)).toEqual(expect.arrayContaining([
      "/api/collaboration/inbox",
      "/api/collaboration/shared",
    ])));
    expectOnlyCollaborationRequests(requests);
  });

  it("shows the unavailable state when discovery fails", async () => {
    const requests = recordFetches(() => jsonResponse({ error: "Collaboration unavailable" }, 503));

    render(<CollaborationFrame view={{ kind: "home" }} />);

    expect(await screen.findByText("Shared items are unavailable")).toBeVisible();
    expectOnlyCollaborationRequests(requests);
  });

  it("shows host-unavailable and access-removed items without leaving the frame", async () => {
    apiState.fake = fakeApi({
      shared: {
        items: [
          { ...acceptedChat, resource: undefined, home: "offline" },
          { ...acceptedChat, scopeId: otherScopeId, resource: undefined, home: "denied" },
        ].map(({ resource: _resource, ...item }) => item),
      },
    });

    render(<CollaborationFrame view={{ kind: "home" }} />);

    expect(await screen.findByText("The owner's computer is offline. Try again later.")).toBeVisible();
    expect(screen.getByText("Access is no longer available.")).toBeVisible();
  });

  it("opens shared items inside the shared destination family", async () => {
    apiState.fake = fakeApi({ shared: { items: [acceptedChat] } });

    render(<CollaborationFrame view={{ kind: "home" }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Chat" }));
    expect(navigation.push).toHaveBeenCalledWith(`/shared/chat/${scopeId}`);
  });

  it("renders a shared Chat inside the frame", async () => {
    navigation.pathname = `/shared/chat/${scopeId}`;
    apiState.fake = fakeApi({});

    render(<CollaborationFrame view={{ kind: "chat", scopeId }} />);

    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeVisible();
    expect(screen.getByText("Contributor")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open discussion" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to Shared with me" })).toHaveAttribute("href", "/shared");
    expect(document.querySelector("[data-matrix-collaboration-frame]")).toBeTruthy();
    for (const nav of screen.getAllByRole("navigation")) {
      expect(within(nav).getByRole("link", { name: /Shared with me/ })).not.toHaveAttribute("aria-current");
    }
  });

  it("offers a computer only as an explicit secondary action", async () => {
    recordFetches();
    render(<CollaborationFrame view={{ kind: "home" }} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu for Mina Member" }), { button: 0, ctrlKey: false });
    const getComputer = await screen.findByRole("menuitem", { name: "Get a Matrix computer" });
    expect(getComputer).toHaveAttribute("href", "/?billing=setup");
    expect(screen.getByText("mina@example.com")).toBeVisible();
  });

  it("closes collaboration sessions before signing out", async () => {
    const requests = recordFetches();
    render(<CollaborationFrame view={{ kind: "home" }} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu for Mina Member" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(clerkState.signOut).toHaveBeenCalledOnce());
    const closeOrder = vi.mocked(closeShellCollaborationSessions).mock.invocationCallOrder[0];
    expect(closeOrder).toBeDefined();
    expect(closeOrder!).toBeLessThan(clerkState.signOut.mock.invocationCallOrder[0]!);
    expect(clerkState.signOut).toHaveBeenCalledWith({ redirectUrl: `${origin}/sign-in?redirect_url=%2Fshared` });
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(`${origin}/sign-in?redirect_url=%2Fshared`));
    expectOnlyCollaborationRequests(requests);
  });

  it("offers sign-in and sign-up that return to the exact destination when signed out", async () => {
    clerkState.isSignedIn = false;
    clerkState.userId = null;
    navigation.pathname = `/shared/chat/${scopeId}`;
    const requests = recordFetches();

    render(<CollaborationFrame view={{ kind: "chat", scopeId }} />);

    const returnTo = encodeURIComponent(`/shared/chat/${scopeId}`);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", `/sign-in?redirect_url=${returnTo}`);
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", `/sign-up?redirect_url=${returnTo}`);
    expect(screen.queryByRole("button", { name: /Account menu/ })).toBeNull();
    expect(requests).toEqual([]);
  });

  it("shows a loading state until the account is known", () => {
    clerkState.isLoaded = false;
    const requests = recordFetches();

    render(<CollaborationFrame view={{ kind: "home" }} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading shared work");
    expect(requests).toEqual([]);
  });
});

describe("post-auth return to shared destinations", () => {
  function clerkProps(testId: string): Record<string, unknown> {
    return JSON.parse(screen.getByTestId(testId).getAttribute("data-props") ?? "{}") as Record<string, unknown>;
  }

  it("completes sign-in and sign-up at a validated shared destination", () => {
    const destination = `/shared/chat/${scopeId}`;
    render(<ShellClerkAuth mode="sign-in" requestedReturn={`${origin}${destination}`} />);
    expect(clerkProps("clerk-sign-in")).toMatchObject({
      forceRedirectUrl: destination,
      fallbackRedirectUrl: destination,
      signUpForceRedirectUrl: destination,
    });
    cleanup();

    render(<ShellClerkAuth mode="sign-up" requestedReturn={destination} />);
    expect(clerkProps("clerk-sign-up")).toMatchObject({
      forceRedirectUrl: destination,
      fallbackRedirectUrl: destination,
      signInForceRedirectUrl: destination,
    });
  });

  it("keeps completion at the app root for other or unsafe destinations", () => {
    for (const requestedReturn of [null, "/", "https://evil.example/shared", "/runtime", "//evil.example/shared"]) {
      render(<ShellClerkAuth mode="sign-in" requestedReturn={requestedReturn} />);
      expect(clerkProps("clerk-sign-in")).toMatchObject({ forceRedirectUrl: "/", fallbackRedirectUrl: "/" });
      cleanup();
    }
  });
});
