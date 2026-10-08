import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useBotRecipes } from "../lib/queries/use-bot-recipes";

const mockFetchNativeBotRecipes = jest.fn();
const mockInstantiateNativeBot = jest.fn();

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_a", getToken: async () => "session-token" }),
}));
jest.mock("@/lib/requests/bots", () => ({
  fetchNativeBotRecipes: (...args: unknown[]) => mockFetchNativeBotRecipes(...args),
  instantiateNativeBot: (...args: unknown[]) => mockInstantiateNativeBot(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const recipe = { recipeId: "inbox-triage", version: "v1" };
const selection = { instanceId: "matrix_pi_default", model: "auto" };
const mounted: (() => void)[] = [];

function renderRecipes(visible = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  // Unless visible, the recipe list itself is not requested.
  const rendered = renderHook(() => useBotRecipes(gatewayUrl, visible), { wrapper });
  mounted.push(rendered.unmount);
  return rendered;
}

describe("useBotRecipes create", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockInstantiateNativeBot.mockResolvedValue({ chatId: "chat_inbox" });
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
  });

  it("creates an agent from a template exactly as before when no name is given", async () => {
    const { result } = renderRecipes();

    await expect(result.current.create(recipe, "req_abcdefgh", selection)).resolves.toBe("chat_inbox");
    await result.current.create(recipe, "req_ijklmnop");

    expect(mockInstantiateNativeBot).toHaveBeenNthCalledWith(1, "session-token", gatewayUrl, {
      recipe, clientRequestId: "req_abcdefgh", selection,
    });
    expect(mockInstantiateNativeBot).toHaveBeenNthCalledWith(2, "session-token", gatewayUrl, {
      recipe, clientRequestId: "req_ijklmnop",
    });
  });

  it("sends the name the person chose, trimmed", async () => {
    const { result } = renderRecipes();

    await result.current.create(recipe, "req_abcdefgh", undefined, "  Morning brief ");

    expect(mockInstantiateNativeBot).toHaveBeenCalledWith("session-token", gatewayUrl, {
      recipe, clientRequestId: "req_abcdefgh", name: "Morning brief",
    });
  });

  it("falls back to the template's name for a name of only spaces", async () => {
    const { result } = renderRecipes();

    await result.current.create(recipe, "req_abcdefgh", selection, "   ");

    expect(mockInstantiateNativeBot).toHaveBeenCalledWith("session-token", gatewayUrl, {
      recipe, clientRequestId: "req_abcdefgh", selection,
    });
  });
});

describe("useBotRecipes refetch", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
  });

  it("reads the templates again after a read that failed", async () => {
    const templates = [{ recipeId: "inbox-triage", version: "v1", name: "Inbox triage", description: "Sorts mail", output: "A tidy inbox" }];
    mockFetchNativeBotRecipes.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(templates);
    const { result } = renderRecipes(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.recipes).toEqual([]);

    await act(async () => {
      await result.current.refetch();
    });

    expect(mockFetchNativeBotRecipes).toHaveBeenCalledTimes(2);
    expect(mockFetchNativeBotRecipes).toHaveBeenLastCalledWith("session-token", gatewayUrl);
    // The hook hears of the answer a moment after the read itself resolves.
    await waitFor(() => expect(result.current.recipes).toEqual(templates));
    expect(result.current.isError).toBe(false);
  });

  it("resolves instead of rejecting when that read fails too", async () => {
    mockFetchNativeBotRecipes.mockRejectedValue(new Error("offline"));
    const { result } = renderRecipes(true);
    await waitFor(() => expect(result.current.isError).toBe(true));

    await act(async () => {
      await expect(result.current.refetch()).resolves.toBeDefined();
    });

    expect(mockFetchNativeBotRecipes).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
