import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const mockGetToken = jest.fn(async () => "owner-token");
const mockCreateConnect = jest.fn(async (..._args: unknown[]) => "https://pipedream.com/connect/test");
const mockGmailOptions = jest.fn(async (..._args: unknown[]) => ({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: mockGetToken, isLoaded: true, isSignedIn: true, userId: "owner" }) }));
jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: async () => ({ handle: "pilot", runtimeSlot: "preview-1", gatewayPath: "/vm/pilot?runtime=preview-1" }),
  fetchAvailableIntegrations: async () => [], fetchConnectedIntegrations: async () => [],
  createIntegrationConnectUrl: (...args: unknown[]) => mockCreateConnect(...args),
  fetchGmailConnectionOptions: (...args: unknown[]) => mockGmailOptions(...args),
  refreshIntegrationConnection: jest.fn(), deleteIntegrationConnection: jest.fn(), syncIntegrationConnections: jest.fn(),
  mobileQueryKeys: { activeComputer: (id: string) => ["active", id], integrations: (id: string, computer: string) => ["integrations", id, computer] },
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
import { useComputerIntegrations } from "@/lib/queries/use-computer-integrations";
it("wires selected method and authenticated capability discovery to the current computer", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useComputerIntegrations(), { wrapper });
  await waitFor(() => expect(view.result.current.computer?.handle).toBe("pilot"));
  await act(async () => { await view.result.current.gmailConnectionOptions(); await view.result.current.startConnection("gmail", { connectionMethod: "pipedream", label: "Work" }); });
  expect(mockGmailOptions).toHaveBeenCalledWith("owner-token", "https://app.matrix-os.com/vm/pilot?runtime=preview-1");
  expect(mockCreateConnect).toHaveBeenCalledWith("owner-token", "https://app.matrix-os.com/vm/pilot?runtime=preview-1", "gmail", { connectionMethod: "pipedream", label: "Work" });
  view.unmount(); client.clear();
});
