jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("../app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => {
      const mockReact = require("react");
      return mockReact.createElement(View, { testID: "expo-image", ...props });
    },
  };
});

jest.mock("@/lib/matrix-files", () => {
  const actual = jest.requireActual("@/lib/matrix-files");
  return {
    __esModule: true,
    ...actual,
    listFiles: jest.fn(),
    searchFiles: jest.fn(),
    listProjects: jest.fn(),
    readTextFile: jest.fn(),
  };
});

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import FilesScreen from "../app/files";
import { useGateway } from "../app/_layout";
import { GatewayClient } from "../lib/gateway-client";
import {
  listFiles,
  listProjects,
  readTextFile,
  searchFiles,
  type ListFilesResult,
  type MatrixFileEntry,
  type SearchFilesResult,
} from "@/lib/matrix-files";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const useGatewayMock = useGateway as jest.MockedFunction<typeof useGateway>;
type GatewayContextValue = ReturnType<typeof useGateway>;

const client = new GatewayClient("https://app.matrix-os.com", "test-token");

function gatewayContext(): GatewayContextValue {
  return {
    client,
    connectionState: "connected",
    gateway: null,
    setGateway: jest.fn(),
    unreadCount: 0,
    incrementUnread: jest.fn(),
    clearUnread: jest.fn(),
  };
}

const rootEntries: MatrixFileEntry[] = [
  { name: "projects", type: "directory", gitStatus: null, children: 3 },
  { name: "README.md", type: "file", size: 2048, gitStatus: null, mime: "text/markdown" },
];

describe("FilesScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGatewayMock.mockReturnValue(gatewayContext());
    jest.mocked(listProjects).mockResolvedValue({ ok: true, projects: [] });
    jest.mocked(listFiles).mockResolvedValue({ ok: true, path: "", entries: rootEntries });
    jest.mocked(searchFiles).mockResolvedValue({ ok: true, results: [], truncated: false });
    jest.mocked(readTextFile).mockResolvedValue({ ok: true, content: "", truncated: false });
  });

  it("renders the directory listing with folders and files", async () => {
    render(<FilesScreen />);

    expect(await screen.findByText("projects")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("navigates into a folder when a directory row is tapped", async () => {
    jest.mocked(listFiles).mockImplementation(async (_client, path) => {
      if (path === "projects") {
        return { ok: true, path: "projects", entries: [{ name: "app.ts", type: "file", gitStatus: null, size: 10 }] };
      }
      return { ok: true, path: "", entries: rootEntries };
    });

    render(<FilesScreen />);

    fireEvent.press(await screen.findByLabelText("Open projects"));

    expect(await screen.findByText("app.ts")).toBeTruthy();
    await waitFor(() => expect(jest.mocked(listFiles)).toHaveBeenCalledWith(client, "projects"));
  });

  it("jumps back to the home root via the breadcrumb", async () => {
    jest.mocked(listFiles).mockImplementation(async (_client, path) => {
      if (path === "projects") {
        return { ok: true, path: "projects", entries: [{ name: "app.ts", type: "file", gitStatus: null, size: 10 }] };
      }
      return { ok: true, path: "", entries: rootEntries };
    });

    render(<FilesScreen />);

    fireEvent.press(await screen.findByLabelText("Open projects"));
    await screen.findByText("app.ts");

    fireEvent.press(screen.getByLabelText("Go to Home"));

    expect(await screen.findByText("README.md")).toBeTruthy();
  });

  it("shows search results within the current folder", async () => {
    jest.mocked(searchFiles).mockResolvedValue({
      ok: true,
      truncated: false,
      results: [
        { path: "notes/todo.md", name: "todo.md", type: "file", matches: [{ text: "todo.md", type: "name" }] },
      ],
    });

    render(<FilesScreen />);
    await screen.findByText("README.md");

    fireEvent.changeText(screen.getByPlaceholderText("Search this folder"), "todo");

    expect(await screen.findByText("todo.md")).toBeTruthy();
    await waitFor(() => expect(jest.mocked(searchFiles)).toHaveBeenCalledWith(client, "", "todo"));
  });

  it("shows an error state and retries the listing", async () => {
    jest
      .mocked(listFiles)
      .mockResolvedValueOnce({ ok: false, error: "Files unavailable. Try again." })
      .mockResolvedValue({ ok: true, path: "", entries: rootEntries });

    render(<FilesScreen />);

    expect(await screen.findByText("Files unavailable. Try again.")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("README.md")).toBeTruthy();
  });

  it("drops a stale folder listing that resolves after navigating away", async () => {
    const slow = deferred<ListFilesResult>();
    jest.mocked(listFiles).mockImplementation(async (_client, path) => {
      if (path === "projects") return slow.promise;
      return { ok: true, path: "", entries: rootEntries };
    });

    render(<FilesScreen />);

    fireEvent.press(await screen.findByLabelText("Open projects"));
    // Navigate back to the root before the slow "projects" listing resolves.
    fireEvent.press(screen.getByLabelText("Go to Home"));
    await screen.findByText("README.md");

    await act(async () => {
      slow.resolve({
        ok: true,
        path: "projects",
        entries: [{ name: "STALE.ts", type: "file", gitStatus: null, size: 1 }],
      });
    });

    expect(screen.queryByText("STALE.ts")).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("drops a stale search that resolves after the query changes", async () => {
    const slowTodo = deferred<SearchFilesResult>();
    jest.mocked(searchFiles).mockImplementation(async (_client, _path, q) => {
      if (q === "todo") return slowTodo.promise;
      return {
        ok: true,
        truncated: false,
        results: [{ path: "notes/note.md", name: "note.md", type: "file", matches: [{ text: "note.md", type: "name" }] }],
      };
    });

    render(<FilesScreen />);
    await screen.findByText("README.md");

    const input = screen.getByPlaceholderText("Search this folder");
    fireEvent.changeText(input, "todo");
    await waitFor(() => expect(jest.mocked(searchFiles)).toHaveBeenCalledWith(client, "", "todo"));

    // Refine the query before the "todo" search resolves.
    fireEvent.changeText(input, "note");
    await waitFor(() => expect(jest.mocked(searchFiles)).toHaveBeenCalledWith(client, "", "note"));
    await screen.findByText("note.md");

    // The stale "todo" search resolving must not overwrite the "note" results.
    await act(async () => {
      slowTodo.resolve({
        ok: true,
        truncated: false,
        results: [{ path: "notes/todo.md", name: "todo.md", type: "file", matches: [{ text: "todo.md", type: "name" }] }],
      });
    });

    expect(screen.queryByText("todo.md")).toBeNull();
    expect(screen.getByText("note.md")).toBeTruthy();
  });

  it("opens a file into the text preview", async () => {
    jest.mocked(readTextFile).mockResolvedValue({ ok: true, content: "# Hello Matrix", truncated: false });

    render(<FilesScreen />);

    fireEvent.press(await screen.findByLabelText("Open README.md"));

    expect(await screen.findByText("# Hello Matrix")).toBeTruthy();
    expect(screen.getByLabelText("Back to files")).toBeTruthy();
    await waitFor(() => expect(jest.mocked(readTextFile)).toHaveBeenCalledWith(client, "README.md"));
  });
});
