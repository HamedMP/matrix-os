import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export interface CanvasLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
}

interface CanvasLabelsState {
  labels: CanvasLabel[];
}

interface CanvasLabelsActions {
  createLabel: (text: string, x: number, y: number, color?: string) => string;
  updateLabel: (id: string, updates: Partial<Pick<CanvasLabel, "text" | "x" | "y" | "color">>) => void;
  deleteLabel: (id: string) => void;
  moveLabel: (id: string, x: number, y: number) => void;
  setLabels: (labels: CanvasLabel[]) => void;
}

export const useCanvasLabels = create<CanvasLabelsState & CanvasLabelsActions>()(
  subscribeWithSelector((set) => ({
    labels: [],

    createLabel: (text, x, y, color = "#ffffff") => {
      const id = `lbl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      set((s) => ({
        labels: [...s.labels, { id, text, x, y, color }],
      }));
      return id;
    },

    updateLabel: (id, updates) => {
      set((s) => ({
        labels: s.labels.map((l) => (l.id === id ? { ...l, ...updates } : l)),
      }));
    },

    deleteLabel: (id) => {
      set((s) => ({ labels: s.labels.filter((l) => l.id !== id) }));
    },

    moveLabel: (id, x, y) => {
      set((s) => ({
        labels: s.labels.map((l) => (l.id === id ? { ...l, x, y } : l)),
      }));
    },

    setLabels: (labels) => set({ labels }),
  })),
);
