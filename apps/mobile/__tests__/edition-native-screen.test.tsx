jest.mock("../components/ui/MenuPicker", () => ({ MenuPicker: () => null }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("../lib/edition/use-edition-runtime", () => ({
  useNativeEditionRuntime: () => ({ runtime: null }),
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { EditionRoom } from "../components/edition/edition-screen";
import { createNativeEditionRuntime } from "../lib/edition/native-runtime";
const source = {
  id: "s1",
  connectionId: "connection-1",
  email: "reader@example.test",
  label: "Reading",
  scope: "personal",
  state: "completed",
};
const article = {
  id: "m1",
  sourceId: "s1",
  subject: "The art of noticing",
  sender: "Observers",
  publication: "Observers",
  receivedAt: "2026-10-06T09:00:00Z",
  excerpt: "A slower kind of attention.",
  text: "<script>danger()</script>\nA slower kind of attention.",
  contentVersion: "v1",
  classification: "newsletter",
  saved: false,
  read: false,
  progress: 0,
  revision: 1,
  readingRevision: 3,
};
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
const computer = {
  handle: "reader",
  runtimeSlot: "slot-1",
  gatewayPath: "/vm/reader/gateway",
};
function fixture() {
  const disk: Record<string, string> = {};
  let network = true;
  let message = article;
  const request = jest.fn(async (_url: any, options: any) => {
    if (!network) throw new TypeError("Network request failed");
    const { action, payload } = JSON.parse(options.body);
    const value =
      action === "sources"
        ? { sources: [source] }
        : action === "messages"
          ? { messages: [message] }
          : action === "cleanup-recovery"
            ? { operations: [] }
            : action === "reading"
              ? (message = {
                  ...message,
                  ...payload,
                  readingRevision: message.readingRevision + 1,
                })
              : message;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
    } as Response;
  });
  const storage = {
    getItem: async (k: string) => disk[k] ?? null,
    setItem: async (k: string, v: string) => {
      disk[k] = v;
    },
    removeItem: async (k: string) => {
      delete disk[k];
    },
  };
  const make = () =>
    createNativeEditionRuntime({
      ownerId: "owner",
      computer,
      getToken: async () => "fresh-token",
      isCurrent: () => true,
      storage,
      fetcher: request,
    });
  return {
    make,
    request,
    disk,
    goOffline: () => {
      network = false;
    },
    goOnline: () => {
      network = true;
    },
  };
}
it("downloads an authenticated article, cold reopens offline and durably replays reading CAS on reconnect", async () => {
  const f = fixture();
  const initial = render(<EditionRoom runtime={f.make()} />);
  fireEvent.press(await screen.findByLabelText("Read The art of noticing"));
  expect(
    await screen.findByText(
      "<script>danger()</script>\nA slower kind of attention.",
    ),
  ).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Download edition"));
  await waitFor(() =>
    expect(screen.getByLabelText("Remove device download")).toBeTruthy(),
  );
  initial.unmount();
  f.goOffline();
  const runtime = f.make();
  const reopened = render(<EditionRoom runtime={runtime} />);
  fireEvent.press(await screen.findByLabelText("Read The art of noticing"));
  expect(
    await screen.findByText(
      "<script>danger()</script>\nA slower kind of attention.",
    ),
  ).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Save edition"));
  await waitFor(() =>
    expect(screen.getByLabelText("Unsave edition")).toBeTruthy(),
  );
  expect(Object.values(f.disk).join("")).not.toContain("fresh-token");
  f.goOnline();
  fireEvent.press(screen.getByLabelText("Retry Edition connection"));
  await waitFor(() =>
    expect(
      f.request.mock.calls.some(([, options]) => {
        const r = JSON.parse(options.body);
        return (
          r.action === "reading" &&
          r.payload.id === "m1" &&
          r.payload.baseRevision === 3 &&
          r.payload.saved === true
        );
      }),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(Object.values(f.disk).join("")).toContain('"readingRevision":4'),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Unsave edition")).toBeTruthy(),
  );
  reopened.unmount();
});
