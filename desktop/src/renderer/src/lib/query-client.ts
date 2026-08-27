import { QueryClient } from "@tanstack/react-query";

export interface DesktopQueryScope {
  platformHost: string;
  authGeneration: number;
  runtimeSlot: string;
}

export function desktopQueryScope({ platformHost, authGeneration, runtimeSlot }: DesktopQueryScope): readonly [string, number, string] {
  return [platformHost, authGeneration, runtimeSlot];
}

export function createDesktopQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export const desktopQueryClient = createDesktopQueryClient();

export function clearDesktopQueryCache(): void {
  void desktopQueryClient.cancelQueries(undefined, { silent: true });
  desktopQueryClient.clear();
}
