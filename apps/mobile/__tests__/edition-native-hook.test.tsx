import { renderHook } from "@testing-library/react-native";
import { useNativeEditionRuntime } from "../lib/edition/use-edition-runtime";

const mockToken = jest.fn(async () => "token");
let mockAuth = {
  getToken: mockToken,
  isLoaded: true,
  isSignedIn: true,
  userId: "owner",
};
let mockComputer = {
  handle: "reader",
  runtimeSlot: "slot-1",
  gatewayPath: "/vm/reader/gateway",
};
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => mockAuth }));
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mockComputer, isPending: false, isError: false }),
}));
jest.mock("../lib/edition/native-runtime", () => ({
  createNativeEditionRuntime: (options: { isCurrent(): boolean }) => ({
    isCurrent: options.isCurrent,
  }),
}));

it("invalidates the committed runtime on owner or computer changes and unmount", () => {
  const { result, rerender, unmount } = renderHook(() =>
    useNativeEditionRuntime(),
  );
  const first = result.current.runtime as unknown as { isCurrent(): boolean };
  expect(first.isCurrent()).toBe(true);
  mockAuth = { ...mockAuth, userId: "other" };
  rerender({});
  expect(first.isCurrent()).toBe(false);
  const second = result.current.runtime as unknown as { isCurrent(): boolean };
  expect(second.isCurrent()).toBe(true);
  mockComputer = { ...mockComputer, runtimeSlot: "slot-2" };
  rerender({});
  expect(second.isCurrent()).toBe(false);
  const third = result.current.runtime as unknown as { isCurrent(): boolean };
  expect(third.isCurrent()).toBe(true);
  unmount();
  expect(third.isCurrent()).toBe(false);
});
