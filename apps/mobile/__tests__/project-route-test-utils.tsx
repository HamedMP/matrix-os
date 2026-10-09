import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react-native";

// Shared by the suites that render the Projects routes over the real query
// hooks. Each suite mocks the modules itself (jest.mock is per file) and points
// them here.

/** What the native sheet was last given. */
export const sheet = {
  isPresented: false,
  onDismiss: (() => {}) as () => void,
};

interface BottomSheetProps {
  children: ReactNode;
  isPresented: boolean;
  onDismiss: () => void;
}

/** Stands in for `@expo/ui`: a sheet that keeps its content while it is closed, as the native one does on its way out. */
export function sheetModule() {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: BottomSheetProps) => {
      sheet.isPresented = props.isPresented;
      sheet.onDismiss = props.onDismiss;
      return <View testID="expo-bottom-sheet">{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
}

export const router = {
  push: jest.fn(),
  back: jest.fn(),
  replace: jest.fn(),
  canGoBack: jest.fn(() => true),
};

/** The route the project screen is on. */
export const route = {
  params: {} as { projectId?: string | string[] },
  focused: true,
};

/** Stands in for `expo-router`. */
export function expoRouterModule() {
  return {
    useRouter: () => router,
    useLocalSearchParams: () => route.params,
    useNavigation: () => ({ isFocused: () => route.focused }),
  };
}

/** What the project screen reaches outside itself, other than the server. */
export const shell = {
  selectChat: jest.fn(),
  setSelectionOverride: jest.fn(),
  bindDraftChatId: jest.fn(),
  showChatScreen: jest.fn(),
  warmSessionToken: jest.fn(),
  /** Called with the props the screen gives the model picker. */
  modelPicker: jest.fn(),
};

export const requests = {
  fetchActiveComputer: jest.fn(),
  fetchProjects: jest.fn(),
  createProject: jest.fn(),
  renameProject: jest.fn(),
  archiveProject: jest.fn(),
  fetchProjectChats: jest.fn(),
  fetchChatProviderCatalog: jest.fn(),
  createChat: jest.fn(),
  admitChatTurn: jest.fn(),
};

/** Stands in for `@/lib/requests`: the real keys and error class over mocked requests. */
export function requestsModule() {
  const calls = Object.fromEntries(
    Object.keys(requests).map((name) => [
      name,
      (...args: unknown[]) => (requests as Record<string, jest.Mock>)[name](...args),
    ]),
  );
  return {
    ...calls,
    mobileQueryKeys: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys,
    ProjectRequestError: jest.requireActual("@/lib/requests/projects").ProjectRequestError,
    canonicalChatTitle: jest.requireActual("@/lib/requests/canonical-chat").canonicalChatTitle,
  };
}

export const GATEWAY_URL = "https://app.matrix-os.com/vm/alice";
export const TOKEN = "session-token";

export const portfolio = { id: "proj_portfolio", slug: "portfolio", name: "Portfolio", kind: "scratch" };
export const matrix = { id: "proj_matrix", slug: "matrix", name: "Matrix", kind: "github" };
export const admin = { id: "proj_admin", slug: "admin", name: "Admin", kind: "scratch" };

// Query results are delivered through React's act() so that every state change
// they cause is flushed before the next assertion.
notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

/** A signed-in account whose computer answers, with three projects and nothing else set up. */
export function resetProjectRoutes() {
  // Only these: resetting every mock would also empty the ones React Native's
  // own test setup renders its host components through.
  for (const mock of [...Object.values(requests), ...Object.values(router)]) mock.mockReset();
  sheet.isPresented = false;
  router.canGoBack.mockReturnValue(true);
  requests.fetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
  requests.fetchProjects.mockResolvedValue([portfolio, matrix, admin]);
}

export const sonnet = { instanceId: "matrix_pi_default", model: "sonnet" };
export const opus = { instanceId: "matrix_pi_default", model: "opus" };
export const catalog = {
  instances: [{
    id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    availability: "available",
    defaultSelection: sonnet,
    models: [
      { id: "sonnet", displayName: "Sonnet 5", availability: "available" },
      { id: "opus", displayName: "Opus 5", availability: "available" },
    ],
    options: [],
    supports: { interactionModes: ["default"], permissionModes: ["supervised"] },
  }],
};

/** A chat of Portfolio that was last active two hours ago. */
export function projectChat(id: string, title: string, lastMessagePreview?: string) {
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "user_a" },
      title,
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      lastMessagePreview,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    },
    projectId: portfolio.id,
  };
}

export const caseStudy = projectChat("chat_case", "Case study", "Draft ready to review");
export const landing = projectChat("chat_landing", "Landing page copy", "Three headline options");
export const pricing = projectChat("chat_pricing", "Pricing page");

/** As `resetProjectRoutes`, with Portfolio changed today, two chats in it and one engine with two models. */
export function resetProjectRoute() {
  resetProjectRoutes();
  for (const mock of Object.values(shell)) mock.mockReset();
  route.params = {};
  route.focused = true;
  requests.fetchProjects.mockResolvedValue([{ ...portfolio, updatedAt: new Date().toISOString() }, matrix, admin]);
  requests.fetchProjectChats.mockResolvedValue({ items: [caseStudy, landing] });
  requests.fetchChatProviderCatalog.mockResolvedValue(catalog);
}

/** The titles of the chat rows on screen, in order. */
export function chatTitles(): string[] {
  return screen
    .queryAllByTestId(/^project-chat-[a-z_]+$/)
    .map((row) => within(row).getAllByText(/./)[0].props.children as string);
}

/** What the screen last gave the model picker. */
export function modelPickerProps() {
  return shell.modelPicker.mock.calls.at(-1)?.[0] as {
    catalog: unknown;
    catalogLoading: boolean;
    selection: unknown;
    onSelectionChange: (selection: unknown) => void;
  };
}

/** Renders the project route (`element`) for `params`, once the projects have been asked for. */
export async function renderProjectRoute(element: ReactElement, params: typeof route.params = { projectId: portfolio.id }) {
  route.params = params;
  const rendered = renderWithQueries(element);
  await waitFor(() => expect(requests.fetchProjects).toHaveBeenCalled());
  return rendered;
}

/** Renders Portfolio and waits for its two chats and its model. */
export async function renderPortfolio(element: ReactElement) {
  const rendered = await renderProjectRoute(element);
  await waitFor(() => expect(chatTitles()).toEqual(["Case study", "Landing page copy"]));
  await waitFor(() => expect(modelPickerProps()?.selection).toEqual(sonnet));
  return rendered;
}

export function renderWithQueries(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return { client, ...render(<QueryClientProvider client={client}>{element}</QueryClientProvider>) };
}

/** A request left open, to settle from the test. */
export function pendingRequest<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
