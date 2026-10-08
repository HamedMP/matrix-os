import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react-native";

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

function renderRecipes() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  // Not visible, so the recipe list itself is not requested.
  const rendered = renderHook(() => useBotRecipes(gatewayUrl, false), { wrapper });
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
