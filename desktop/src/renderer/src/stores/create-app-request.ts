import { create } from "zustand";

const CREATE_APP_PROMPT = "/matrix-app-builder ";

interface CreateAppRequestState {
  request: { id: number; prompt: string } | null;
  requestDraft: () => void;
  clear: (id: number) => void;
}

let nextRequestId = 0;

export const useCreateAppRequest = create<CreateAppRequestState>((set, get) => ({
  request: null,
  requestDraft: () => set({ request: { id: ++nextRequestId, prompt: CREATE_APP_PROMPT } }),
  clear: (id) => {
    if (get().request?.id === id) set({ request: null });
  },
}));
