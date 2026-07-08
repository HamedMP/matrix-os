import React from "react";
import { vi } from "vitest";

export const fakeEditor = {
  isFocused: true,
  getHTML: vi.fn(() => "<p></p>"),
  getJSON: vi.fn(() => ({ type: "doc", content: [] })),
  chain: vi.fn(() => fakeEditor),
  focus: vi.fn(() => fakeEditor),
  toggleBold: vi.fn(() => fakeEditor),
  toggleItalic: vi.fn(() => fakeEditor),
  toggleStrike: vi.fn(() => fakeEditor),
  toggleHeading: vi.fn(() => fakeEditor),
  toggleBulletList: vi.fn(() => fakeEditor),
  toggleOrderedList: vi.fn(() => fakeEditor),
  toggleBlockquote: vi.fn(() => fakeEditor),
  toggleCodeBlock: vi.fn(() => fakeEditor),
  run: vi.fn(() => true),
  isActive: vi.fn(() => false),
  commands: {
    focus: vi.fn(),
    setContent: vi.fn(),
  },
};

export function EditorContent() {
  return React.createElement("div", { "data-testid": "editor-content" });
}

export function useEditor() {
  return fakeEditor;
}

export type Editor = typeof fakeEditor;
