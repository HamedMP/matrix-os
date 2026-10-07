import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  CanonicalChatListResponseSchema,
  CanonicalProviderCatalogSchema,
  MatrixComputerSchema,
} from "@matrix-os/contracts";
import type { QueryKey } from "@tanstack/react-query";

import { mobileQueryClient } from "@/lib/query-client";
import { createQueryPersistence, type PersistedQueryKind } from "@/lib/query-persistence";
import { ProjectSummaryListSchema } from "@/lib/requests/projects";
import { mobileQueryKeys } from "@/lib/requests/query-keys";
import { MobileSystemInfoSchema } from "@/lib/requests/settings";

function sameKey(left: QueryKey, right: QueryKey): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Matches `queryKey` against one of the `mobileQueryKeys` builders and returns the user it is scoped to. */
function ownerOf(
  queryKey: QueryKey,
  userIdIndex: number,
  build: (userId: string, computerKey: string) => QueryKey,
): string | null {
  const userId = queryKey[userIdIndex];
  const computerKey = queryKey[userIdIndex + 1];
  if (typeof userId !== "string") return null;
  return sameKey(queryKey, build(userId, typeof computerKey === "string" ? computerKey : "")) ? userId : null;
}

/**
 * What the home screen needs before it is usable: which computer to talk to,
 * the chats in the drawer, the models the composer can send with, the projects
 * a new chat can go in, and the capabilities the drawer shows.
 */
const kinds: PersistedQueryKind[] = [
  {
    id: "active-computer",
    ownerOf: (queryKey) => ownerOf(queryKey, 3, (userId) => mobileQueryKeys.activeComputer(userId)),
    parse: (data) => MatrixComputerSchema.parse(data),
  },
  {
    id: "chats",
    ownerOf: (queryKey) => ownerOf(queryKey, 2, mobileQueryKeys.canonicalChats),
    parse: (data) => CanonicalChatListResponseSchema.parse(data),
  },
  {
    id: "chat-providers",
    ownerOf: (queryKey) => ownerOf(queryKey, 2, mobileQueryKeys.chatProviderCatalog),
    parse: (data) => CanonicalProviderCatalogSchema.parse(data),
  },
  {
    id: "projects",
    ownerOf: (queryKey) => ownerOf(queryKey, 2, mobileQueryKeys.projects),
    parse: (data) => ProjectSummaryListSchema.parse(data),
  },
  {
    id: "system-info",
    ownerOf: (queryKey) => ownerOf(queryKey, 3, mobileQueryKeys.systemInfo),
    parse: (data) => MobileSystemInfoSchema.parse(data),
  },
];

export const mobileQueryPersistence = createQueryPersistence({
  queryClient: mobileQueryClient,
  storage: AsyncStorage,
  kinds,
});
