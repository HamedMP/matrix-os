import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import * as mockRoutes from "./project-route-test-utils";
import ProjectRoute from "../app/(drawer)/(tabs)/(chats)/projects/[projectId]";
import { composerChoices } from "@/lib/remembered-composer-choice";

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: async () => "session-token" }),
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
jest.mock("@/lib/requests", () => mockRoutes.requestsModule());
jest.mock("expo-router", () => mockRoutes.expoRouterModule());
jest.mock("@expo/ui", () => mockRoutes.sheetModule());
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));
jest.mock("@/lib/canonical-chat-session-context", () => ({ useCanonicalChatSession: () => mockRoutes.shell }));
jest.mock("@/lib/use-session-token-warmup", () => ({
  useSessionTokenWarmup: () => mockRoutes.shell.warmSessionToken,
}));
jest.mock("@/components/ModelPicker", () => ({
  ModelPicker: (props: unknown) => {
    mockRoutes.shell.modelPicker(props);
    return null;
  },
}));

// The reanimated mock in jest.setup.js has no `cancelAnimation`, which the
// skeleton rows call when they unmount.
const reanimated = jest.requireMock<{ cancelAnimation?: unknown }>("react-native-reanimated");
reanimated.cancelAnimation ??= jest.fn();

const { requests, shell, catalog, sonnet, GATEWAY_URL, TOKEN, modelPickerProps } = mockRoutes;

// The engine runs turns in all four modes, as the computer lists Claude Code and Codex.
const fourModes = {
  instances: catalog.instances.map((instance) => ({
    ...instance,
    supports: { ...instance.supports, permissionModes: ["supervised", "auto_accept_edits", "auto", "full_access"] },
  })),
};
const created = { chat: { id: "chat_new", revision: 0 }, projectId: "proj_portfolio" };
const admission = { message: { id: "msg_1" } };

const input = () => screen.getByLabelText("Message Matrix");
const sendButton = () => screen.getByRole("button", { name: "Send message" });

async function startChat(text: string) {
  fireEvent.changeText(input(), text);
  fireEvent.press(sendButton());
  await waitFor(() => expect(requests.admitChatTurn).toHaveBeenCalledTimes(1));
}

describe("the permission mode a project chat starts with", () => {
  beforeEach(async () => {
    mockRoutes.resetProjectRoute();
    requests.fetchChatProviderCatalog.mockResolvedValue(fourModes);
    requests.createChat.mockResolvedValue(created);
    requests.admitChatTurn.mockResolvedValue(admission);
    await composerChoices.forget();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await mockRoutes.cleanupProjectRoute();
    jest.restoreAllMocks();
  });

  it("is Supervised when none was chosen on this phone", async () => {
    await mockRoutes.renderPortfolio(<ProjectRoute />);
    await waitFor(() => expect(modelPickerProps().permissionMode).toBe("supervised"));

    await startChat("Draft the case study");

    expect(requests.admitChatTurn).toHaveBeenCalledWith(expect.any(Function), GATEWAY_URL, "chat_new", expect.objectContaining({
      selection: sonnet, permissionMode: "supervised",
    }));
  });

  it("is the one last chosen on this phone", async () => {
    act(() => composerChoices.remember("user_a:alice:primary", { permissionMode: "full_access" }));
    await mockRoutes.renderPortfolio(<ProjectRoute />);
    await waitFor(() => expect(modelPickerProps().permissionMode).toBe("full_access"));

    await startChat("Draft the case study");

    expect(requests.admitChatTurn).toHaveBeenCalledWith(expect.any(Function), GATEWAY_URL, "chat_new", expect.objectContaining({
      permissionMode: "full_access",
    }));
  });

  it("is the one chosen here, which is remembered, and stays with the chat it started", async () => {
    await mockRoutes.renderPortfolio(<ProjectRoute />);
    act(() => modelPickerProps().onPermissionModeChange?.("auto"));
    await waitFor(() => expect(modelPickerProps().permissionMode).toBe("auto"));

    await startChat("Draft the case study");

    expect(requests.admitChatTurn).toHaveBeenCalledWith(expect.any(Function), GATEWAY_URL, "chat_new", expect.objectContaining({
      permissionMode: "auto",
    }));
    await waitFor(() => expect(shell.setPermissionModeOverride).toHaveBeenCalledWith("auto"));
    expect(composerChoices.choice("user_a:alice:primary")).toEqual({ permissionMode: "auto" });
  });

  it("falls back to Supervised on an engine without the chosen mode", async () => {
    requests.fetchChatProviderCatalog.mockResolvedValue(catalog);
    act(() => composerChoices.remember("user_a:alice:primary", { permissionMode: "full_access" }));
    await mockRoutes.renderPortfolio(<ProjectRoute />);

    await startChat("Draft the case study");

    expect(requests.admitChatTurn).toHaveBeenCalledWith(expect.any(Function), GATEWAY_URL, "chat_new", expect.objectContaining({
      permissionMode: "supervised",
    }));
    expect(composerChoices.choice("user_a:alice:primary")?.permissionMode).toBe("full_access");
  });
});
