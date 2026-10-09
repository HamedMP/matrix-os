import type { QueryClient } from "@tanstack/react-query";

/** Call after unmounting this test client's query/mutation observers. */
export async function disposeTestQueryClient(client: QueryClient): Promise<void> {
  await client.cancelQueries();
  // MutationCache.clear() removes records but does not cancel their GC timers.
  for (const mutation of client.getMutationCache().getAll()) mutation.destroy();
  client.clear();
}
