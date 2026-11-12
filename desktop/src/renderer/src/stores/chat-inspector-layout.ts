import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod/v4";

const LayoutSchema = z.object({
  width: z.number().int().min(240).max(820).default(400),
  selectedTabId: z.string().min(1).max(200).default("files"),
  openTabIds: z.array(z.string().min(1).max(200)).max(12).default(["files"]),
}).strict();
type Layout = z.infer<typeof LayoutSchema>;
const EntrySchema = z.object({ key: z.string().min(1).max(2048), layout: LayoutSchema }).strict();
const EntriesSchema = z.array(EntrySchema).max(32);

export function chatInspectorLayoutKey(userId: string, runtimeSlot: string, chatId: string): string {
  return JSON.stringify([
    z.string().min(1).max(256).parse(userId),
    z.string().min(1).max(512).parse(runtimeSlot),
    z.string().min(1).max(200).parse(chatId),
  ]);
}

export const useChatInspectorLayout = create<{
  entries: Array<{ key: string; layout: Layout }>;
  get(key: string): Layout | null;
  update(key: string, patch: Partial<Layout>): void;
}>()(persist((set, get) => ({
  entries: [],
  get: key => get().entries.find(entry => entry.key === key)?.layout ?? null,
  update: (key, patch) => set(state => {
    const previous = state.entries.find(entry => entry.key === key)?.layout;
    const layout = LayoutSchema.parse({ ...previous, ...patch });
    const entry = EntrySchema.parse({ key, layout });
    return { entries: [...state.entries.filter(current => current.key !== key), entry].slice(-32) };
  }),
}), {
  name: "matrix-chat-inspector-layout-v1",
  storage: createJSONStorage(() => localStorage),
  partialize: state => ({ entries: state.entries }),
  merge: (saved, current) => {
    const parsed = EntriesSchema.safeParse((saved as { entries?: unknown } | null)?.entries);
    return parsed.success ? { ...current, entries: parsed.data } : current;
  },
}));
