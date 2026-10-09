import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react-native";

import * as mockRoutes from "./project-route-test-utils";
import ProjectsRoute from "../app/(drawer)/(tabs)/(chats)/projects/index";
import { ProjectRequestError } from "../lib/requests/projects";

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: async () => "session-token" }),
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
jest.mock("@/lib/requests", () => mockRoutes.requestsModule());
jest.mock("expo-router", () => ({ useRouter: () => mockRoutes.router }));
jest.mock("@expo/ui", () => mockRoutes.sheetModule());
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));

const { requests, router, sheet, portfolio, matrix, admin, GATEWAY_URL, TOKEN, pendingRequest } = mockRoutes;

const fresh = { id: "proj_fresh", slug: "field-notes", name: "Field notes", kind: "scratch" };

function rowNames(): string[] {
  return screen
    .getAllByTestId(/^project-row-[a-z_]+$/)
    .map((row) => within(row).getAllByText(/./)[0].props.children as string);
}

async function renderList() {
  const rendered = mockRoutes.renderWithQueries(<ProjectsRoute />);
  await waitFor(() => expect(screen.getByTestId("projects-list")).toBeTruthy());
  return rendered;
}

const nameField = () => screen.getByLabelText("Project name");
const createButton = () => screen.getByRole("button", { name: "Create" });

async function openSheetAndType(name: string) {
  await renderList();
  fireEvent.press(screen.getByRole("button", { name: "New project" }));
  fireEvent.changeText(nameField(), name);
}

describe("projects route", () => {
  beforeEach(() => {
    mockRoutes.resetProjectRoutes();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  describe("list", () => {
    it("shows skeleton rows until the projects have been read", async () => {
      const read = pendingRequest<unknown[]>();
      requests.fetchProjects.mockReturnValue(read.promise);
      mockRoutes.renderWithQueries(<ProjectsRoute />);

      await waitFor(() => expect(requests.fetchProjects).toHaveBeenCalledTimes(1));
      expect(screen.getAllByTestId("project-skeleton-row").length).toBeGreaterThan(0);
      expect(screen.queryByTestId("projects-list")).toBeNull();

      await act(async () => read.resolve([portfolio]));
      await waitFor(() => expect(rowNames()).toEqual(["Portfolio"]));
    });

    it("lists the computer's projects in the server's order", async () => {
      await renderList();

      expect(requests.fetchProjects).toHaveBeenCalledWith(TOKEN, GATEWAY_URL);
      expect(rowNames()).toEqual(["Portfolio", "Matrix", "Admin"]);
    });

    it("shows when a project last changed once the list carries that, and only the name until then", async () => {
      requests.fetchProjects.mockResolvedValue([{ ...portfolio, updatedAt: new Date().toISOString() }, matrix]);
      await renderList();

      expect(within(screen.getByTestId("project-row-proj_portfolio")).getByText("Updated today")).toBeTruthy();
      expect(within(screen.getByTestId("project-row-proj_matrix")).getAllByText(/./)).toHaveLength(1);
    });

    it("filters by name as the search is typed, and says so when nothing matches", async () => {
      await renderList();

      fireEvent.changeText(screen.getByLabelText("Search projects"), "ma");
      expect(rowNames()).toEqual(["Matrix"]);

      fireEvent.changeText(screen.getByLabelText("Search projects"), "zebra");
      expect(screen.queryByTestId(/^project-row-/)).toBeNull();
      expect(screen.getByText("No projects match that search.")).toBeTruthy();

      fireEvent.changeText(screen.getByLabelText("Search projects"), "");
      expect(rowNames()).toEqual(["Portfolio", "Matrix", "Admin"]);
      expect(requests.fetchProjects).toHaveBeenCalledTimes(1);
    });

    it("opens the project whose row is pressed", async () => {
      await renderList();

      fireEvent.press(screen.getByTestId("project-row-proj_matrix"));

      expect(router.push).toHaveBeenCalledWith({ pathname: "/projects/[projectId]", params: { projectId: "proj_matrix" } });
    });

    it("goes back to the chat screen, also when a link opened the list with nothing beneath it", async () => {
      await renderList();

      fireEvent.press(screen.getByRole("button", { name: "Back" }));
      expect(router.back).toHaveBeenCalledTimes(1);
      expect(router.replace).not.toHaveBeenCalled();

      router.canGoBack.mockReturnValue(false);
      fireEvent.press(screen.getByRole("button", { name: "Back" }));
      expect(router.back).toHaveBeenCalledTimes(1);
      expect(router.replace).toHaveBeenCalledWith("/(drawer)");
    });

    it("reads the projects again on pull to refresh, with the spinner until they have answered", async () => {
      await renderList();
      const read = pendingRequest<unknown[]>();
      requests.fetchProjects.mockReturnValue(read.promise);

      fireEvent(screen.getByTestId("projects-list"), "refresh");
      await waitFor(() => expect(screen.getByTestId("projects-list").props.refreshing).toBe(true));
      expect(requests.fetchProjects).toHaveBeenCalledTimes(2);

      await act(async () => read.resolve([admin]));
      await waitFor(() => expect(screen.getByTestId("projects-list").props.refreshing).toBe(false));
      expect(rowNames()).toEqual(["Admin"]);
    });

    it("says in generic words that the projects could not be loaded, and reads them again from Try again", async () => {
      requests.fetchProjects.mockRejectedValue(new Error("upstream said no"));
      mockRoutes.renderWithQueries(<ProjectsRoute />);

      await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("Projects could not be loaded."));
      expect(screen.queryByText(/upstream/)).toBeNull();

      requests.fetchProjects.mockResolvedValue([portfolio]);
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() => expect(rowNames()).toEqual(["Portfolio"]));
    });

    it("asks for the computer again from Try again when it was the computer that could not be found", async () => {
      requests.fetchActiveComputer.mockRejectedValue(new Error("no computer"));
      mockRoutes.renderWithQueries(<ProjectsRoute />);
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(requests.fetchProjects).not.toHaveBeenCalled();

      requests.fetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
      fireEvent.press(screen.getByRole("button", { name: "Try again" }));

      await waitFor(() => expect(rowNames()).toEqual(["Portfolio", "Matrix", "Admin"]));
    });

    it("keeps showing the projects it has when reading them again fails", async () => {
      await renderList();
      requests.fetchProjects.mockRejectedValue(new Error("upstream said no"));

      fireEvent(screen.getByTestId("projects-list"), "refresh");
      await waitFor(() => expect(requests.fetchProjects).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId("projects-list").props.refreshing).toBe(false));

      expect(rowNames()).toEqual(["Portfolio", "Matrix", "Admin"]);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows the empty state when there are no projects, and its action opens the new project sheet", async () => {
      requests.fetchProjects.mockResolvedValue([]);
      await renderList();

      expect(sheet.isPresented).toBe(false);
      fireEvent.press(within(screen.getByTestId("projects-empty")).getByRole("button", { name: "New project" }));

      expect(sheet.isPresented).toBe(true);
    });
  });

  describe("new project", () => {
    it("opens the sheet from New project, with Create unavailable while the name is blank", async () => {
      await renderList();
      expect(sheet.isPresented).toBe(false);

      fireEvent.press(screen.getByRole("button", { name: "New project" }));

      expect(sheet.isPresented).toBe(true);
      expect(screen.getByRole("header", { name: "New project" })).toBeTruthy();
      expect(nameField().props.value).toBe("");
      expect(createButton().props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(createButton());
      expect(requests.createProject).not.toHaveBeenCalled();
    });

    it("closes the sheet from Cancel without creating anything", async () => {
      await openSheetAndType("Field notes");

      fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

      expect(sheet.isPresented).toBe(false);
      expect(requests.createProject).not.toHaveBeenCalled();
    });

    it("creates the project, shows the request in flight, then closes the sheet and opens the project", async () => {
      const created = pendingRequest<typeof fresh>();
      requests.createProject.mockReturnValue(created.promise);
      await openSheetAndType("  Field notes ");

      fireEvent.press(createButton());
      await waitFor(() => expect(createButton().props.accessibilityState).toMatchObject({ busy: true }));
      expect(requests.createProject).toHaveBeenCalledWith(TOKEN, GATEWAY_URL, {
        name: "Field notes",
        clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9]+$/),
      });
      // Nothing moves until the server answers.
      expect(sheet.isPresented).toBe(true);
      expect(router.push).not.toHaveBeenCalled();
      expect(rowNames()).toEqual(["Portfolio", "Matrix", "Admin"]);

      requests.fetchProjects.mockResolvedValue([fresh, portfolio, matrix, admin]);
      await act(async () => created.resolve(fresh));

      await waitFor(() => expect(sheet.isPresented).toBe(false));
      expect(router.push).toHaveBeenCalledWith({ pathname: "/projects/[projectId]", params: { projectId: "proj_fresh" } });
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(rowNames()[0]).toBe("Field notes");
    });

    it("keeps the sheet and the name, and says the name is taken, when the server says so", async () => {
      requests.createProject.mockRejectedValue(new ProjectRequestError("name_taken"));
      await openSheetAndType("Portfolio");

      fireEvent.press(createButton());

      await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("A project with that name already exists."));
      expect(sheet.isPresented).toBe(true);
      expect(nameField().props.value).toBe("Portfolio");
      expect(router.push).not.toHaveBeenCalled();
      expect(createButton().props.accessibilityState).toMatchObject({ busy: false, disabled: false });
    });

    it.each([
      new ProjectRequestError("invalid_name"),
      new ProjectRequestError("unavailable"),
      new Error("upstream said no"),
    ])("says in generic words that the project could not be created for any other failure (%p)", async (failure) => {
      requests.createProject.mockRejectedValue(failure);
      await openSheetAndType("Field notes");

      fireEvent.press(createButton());

      await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("Project could not be created. Try again."));
      expect(screen.queryByText(/upstream/)).toBeNull();
      expect(nameField().props.value).toBe("Field notes");
    });

    it("retries the same name under the same request id, and another name under a new one", async () => {
      requests.createProject.mockRejectedValue(new ProjectRequestError("unavailable"));
      await openSheetAndType("Field notes");

      fireEvent.press(createButton());
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      fireEvent.press(createButton());
      await waitFor(() => expect(requests.createProject).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(createButton().props.accessibilityState).toMatchObject({ busy: false }));

      fireEvent.changeText(nameField(), "Trip");
      fireEvent.press(createButton());
      await waitFor(() => expect(requests.createProject).toHaveBeenCalledTimes(3));

      const ids = requests.createProject.mock.calls.map(([, , input]) => (input as { clientRequestId: string }).clientRequestId);
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).not.toBe(ids[0]);
    });

    it("clears the failure line while the next attempt is on its way, and when the sheet is opened again", async () => {
      requests.createProject.mockRejectedValueOnce(new ProjectRequestError("name_taken"));
      const retry = pendingRequest<typeof fresh>();
      requests.createProject.mockReturnValueOnce(retry.promise);
      await openSheetAndType("Portfolio");
      fireEvent.press(createButton());
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

      fireEvent.press(createButton());
      await waitFor(() => expect(createButton().props.accessibilityState).toMatchObject({ busy: true }));
      expect(screen.queryByRole("alert")).toBeNull();

      await act(async () => retry.reject(new ProjectRequestError("name_taken")));
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

      fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.press(screen.getByRole("button", { name: "New project" }));

      expect(sheet.isPresented).toBe(true);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(nameField().props.value).toBe("");
    });
  });
});
