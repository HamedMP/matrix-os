import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { Alert, type AlertButton } from "react-native";

import * as mockRoutes from "./project-route-test-utils";
import ProjectRoute from "../app/(drawer)/(tabs)/(chats)/projects/[projectId]";
import { ProjectRequestError } from "../lib/requests/projects";

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
jest.mock("@/lib/use-shell-navigation", () => ({ useShowChatScreen: () => mockRoutes.shell.showChatScreen }));
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

const { requests, router, sheet, portfolio, matrix, admin, GATEWAY_URL, TOKEN, pendingRequest } = mockRoutes;

const options = () => screen.getByRole("button", { name: "Project options" });
const menuRow = (name: "Rename" | "Archive project") => screen.getByRole("button", { name });
const headerName = (name: string) => within(screen.getByTestId("project-header")).getByText(name);

async function openMenu() {
  await mockRoutes.renderPortfolio(<ProjectRoute />);
  fireEvent.press(options());
}

describe("project route options", () => {
  let alert: jest.SpyInstance;

  beforeEach(() => {
    mockRoutes.resetProjectRoute();
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it("opens the menu sheet from the options button, with Rename and Archive project and nothing else", async () => {
    await mockRoutes.renderPortfolio(<ProjectRoute />);
    expect(sheet.isPresented).toBe(false);

    fireEvent.press(options());

    expect(sheet.isPresented).toBe(true);
    const menu = screen.getByTestId("project-menu");
    expect(within(menu).getByRole("header", { name: "Portfolio" })).toBeTruthy();
    expect(within(menu).getByText("Updated today")).toBeTruthy();
    expect(within(menu).getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      "Rename",
      "Archive project",
    ]);
    for (const text of ["Project instructions", "Share project", "Delete project"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  it("closes the sheet when it is dragged away", async () => {
    await openMenu();

    act(() => sheet.onDismiss());

    expect(sheet.isPresented).toBe(false);
  });

  describe("rename", () => {
    const renamed = { ...portfolio, name: "Case studies" };
    const nameField = () => screen.getByLabelText("Project name");
    const save = () => screen.getByRole("button", { name: "Save" });

    async function openRename() {
      await openMenu();
      fireEvent.press(menuRow("Rename"));
    }

    it("shows the rename form in place of the menu, filled with the name and unable to save it unchanged", async () => {
      await openRename();

      expect(sheet.isPresented).toBe(true);
      expect(screen.queryByTestId("project-menu")).toBeNull();
      expect(screen.getByRole("header", { name: "Rename project" })).toBeTruthy();
      expect(nameField().props.value).toBe("Portfolio");
      expect(save().props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.changeText(nameField(), "  ");
      expect(save().props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(save());
      expect(requests.renameProject).not.toHaveBeenCalled();
    });

    it("renames the project by its slug, shows the request in flight, then closes the sheet with the new name on screen", async () => {
      const saved = pendingRequest<typeof renamed>();
      requests.renameProject.mockReturnValue(saved.promise);
      await openRename();

      fireEvent.changeText(nameField(), " Case studies ");
      fireEvent.press(save());

      await waitFor(() => expect(save().props.accessibilityState).toMatchObject({ busy: true }));
      expect(requests.renameProject).toHaveBeenCalledWith(TOKEN, GATEWAY_URL, "portfolio", "Case studies");
      expect(sheet.isPresented).toBe(true);
      expect(headerName("Portfolio")).toBeTruthy();

      requests.fetchProjects.mockResolvedValue([renamed, matrix, admin]);
      await act(async () => saved.resolve(renamed));

      await waitFor(() => expect(sheet.isPresented).toBe(false));
      expect(headerName("Case studies")).toBeTruthy();
      expect(screen.getByLabelText("Message Matrix").props.placeholder).toBe("New chat in Case studies");
    });

    it.each([
      [new ProjectRequestError("name_taken"), "A project with that name already exists."],
      [new ProjectRequestError("conflict"), "Project could not be renamed. Try again."],
      [new Error("upstream said no"), "Project could not be renamed. Try again."],
    ])("keeps the sheet and the typed name after a failure (%p)", async (failure, line) => {
      requests.renameProject.mockRejectedValue(failure);
      await openRename();

      fireEvent.changeText(nameField(), "Matrix");
      fireEvent.press(save());

      await waitFor(() => expect(screen.getByRole("alert").props.children).toBe(line));
      expect(sheet.isPresented).toBe(true);
      expect(nameField().props.value).toBe("Matrix");
      expect(screen.queryByText(/upstream/)).toBeNull();
      expect(headerName("Portfolio")).toBeTruthy();
    });

    it("opens clean after an earlier failure", async () => {
      requests.renameProject.mockRejectedValue(new ProjectRequestError("name_taken"));
      await openRename();
      fireEvent.changeText(nameField(), "Matrix");
      fireEvent.press(save());
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

      fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
      expect(sheet.isPresented).toBe(false);
      fireEvent.press(options());
      fireEvent.press(menuRow("Rename"));

      expect(screen.queryByRole("alert")).toBeNull();
      expect(nameField().props.value).toBe("Portfolio");
    });
  });

  describe("archive", () => {
    const archived = { ...portfolio, archivedAt: "2026-10-09T10:00:00.000Z" };

    function confirmation(): { title: string; message: string; buttons: AlertButton[] } {
      const [title, message, buttons] = alert.mock.calls[0] as [string, string, AlertButton[]];
      return { title, message, buttons };
    }

    const confirm = () => act(() => confirmation().buttons[1].onPress?.());

    async function askToArchive() {
      await openMenu();
      fireEvent.press(menuRow("Archive project"));
    }

    it("asks first, saying what happens to the chats, and does nothing until it is confirmed", async () => {
      await askToArchive();

      expect(alert).toHaveBeenCalledTimes(1);
      expect(confirmation().title).toBe("Archive Portfolio?");
      expect(confirmation().message).toBe("It leaves your project list. Its chats are kept.");
      expect(confirmation().buttons.map((button) => button.text)).toEqual(["Cancel", "Archive"]);
      expect(confirmation().buttons[0].style).toBe("cancel");
      expect(requests.archiveProject).not.toHaveBeenCalled();

      confirmation().buttons[0].onPress?.();
      expect(requests.archiveProject).not.toHaveBeenCalled();
      expect(sheet.isPresented).toBe(true);
    });

    it("archives the project by its slug and only then closes the sheet and returns to the list", async () => {
      const request = pendingRequest<typeof archived>();
      requests.archiveProject.mockReturnValue(request.promise);
      await askToArchive();

      confirm();

      await waitFor(() => expect(menuRow("Archive project").props.accessibilityState).toMatchObject({ disabled: true }));
      expect(menuRow("Rename").props.accessibilityState).toMatchObject({ disabled: true });
      expect(requests.archiveProject).toHaveBeenCalledWith(TOKEN, GATEWAY_URL, "portfolio");
      // Nothing leaves the screen before the server confirms.
      expect(sheet.isPresented).toBe(true);
      expect(router.back).not.toHaveBeenCalled();
      expect(headerName("Portfolio")).toBeTruthy();

      requests.fetchProjects.mockResolvedValue([matrix, admin]);
      await act(async () => request.resolve(archived));

      await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
      expect(sheet.isPresented).toBe(false);
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it("returns to the list by replacing the screen when a link opened the project with nothing beneath it", async () => {
      requests.archiveProject.mockResolvedValue(archived);
      router.canGoBack.mockReturnValue(false);
      await askToArchive();

      confirm();

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/projects"));
      expect(router.back).not.toHaveBeenCalled();
    });

    it("keeps showing the project on its way out, once the list no longer has it", async () => {
      requests.archiveProject.mockResolvedValue(archived);
      await askToArchive();
      requests.fetchProjects.mockResolvedValue([matrix, admin]);

      confirm();

      await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(requests.fetchProjects).toHaveBeenCalledTimes(2));
      expect(screen.queryByText("Project not found")).toBeNull();
      expect(headerName("Portfolio")).toBeTruthy();
    });

    it("says the project has work running when the server refuses for that, and keeps everything in place", async () => {
      requests.archiveProject.mockRejectedValue(new ProjectRequestError("project_active"));
      await askToArchive();

      confirm();

      await waitFor(() => expect(alert).toHaveBeenCalledTimes(2));
      expect(alert).toHaveBeenLastCalledWith(
        "Project could not be archived",
        "This project has work running. Try again when it finishes.",
      );
      expect(sheet.isPresented).toBe(true);
      expect(router.back).not.toHaveBeenCalled();
      expect(headerName("Portfolio")).toBeTruthy();
      expect(menuRow("Archive project").props.accessibilityState).toMatchObject({ disabled: false });
    });

    it.each([
      new ProjectRequestError("conflict"),
      new ProjectRequestError("unavailable"),
      new Error("upstream said no"),
    ])("shows a generic alert for any other failure (%p)", async (failure) => {
      requests.archiveProject.mockRejectedValue(failure);
      await askToArchive();

      confirm();

      await waitFor(() => expect(alert).toHaveBeenCalledTimes(2));
      expect(alert).toHaveBeenLastCalledWith("Project could not be archived", "Try again.");
      expect(JSON.stringify(alert.mock.calls)).not.toContain("upstream");
      expect(sheet.isPresented).toBe(true);
      expect(router.back).not.toHaveBeenCalled();
    });
  });
});
