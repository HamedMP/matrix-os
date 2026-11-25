/**
 * A fake `window.MatrixOS` for the Docs app shell tests: the versioned
 * in-memory files bridge of the session tests plus directory listing, open
 * requests and the recent-documents table.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React, { StrictMode } from "react";
import type { BridgeFileEntry, BridgeFileListing, OpenRequest } from "../../../../home/apps/_shared/matrix-os";
import { createDocx, createDocxFromMarkdown } from "../../../../home/apps/_shared/office-engine/index";
import App from "../../../../home/apps/docs/src/App";
import { bridgeError, createFakeDb, createFakeFiles, type FakeDb, type FakeFiles } from "../session/fakes";

export const OWNER = "Rae Okafor";

export async function docxFromParagraphs(paragraphs: string[]): Promise<Uint8Array> {
  return createDocx({ paragraphs }).save();
}

export async function docxFromMarkdown(markdown: string): Promise<Uint8Array> {
  return createDocxFromMarkdown(markdown).save();
}

export interface FakeBridge {
  files: FakeFiles & {
    list(dir: string): Promise<BridgeFileListing>;
    openRequest(): Promise<OpenRequest | null>;
    onOpenRequest(callback: (request: OpenRequest) => void): () => void;
    mkdir(path: string): Promise<{ path: string }>;
  };
  db: FakeDb;
  /** Paths `list` reports, besides files written by the app. */
  paths: Set<string>;
  openRequestCalls: number;
  listCalls: string[];
  /** Delivers an open request to running listeners. */
  sendOpenRequest(path: string): void;
  failListOnce(): void;
}

let nonce = 0;

function request(path: string): OpenRequest {
  nonce++;
  return { path, requestedAt: "2026-11-23T10:00:00.000Z", nonce: `n${nonce}` };
}

export function installBridge(initial: Record<string, Uint8Array>, options: { pending?: string; extraPaths?: string[] } = {}): FakeBridge {
  const base = createFakeFiles(initial);
  const db = createFakeDb();
  const paths = new Set([...Object.keys(initial), ...(options.extraPaths ?? [])]);
  const listeners = new Set<(request: OpenRequest) => void>();
  let pending: OpenRequest | null = options.pending === undefined ? null : request(options.pending);
  let failList = false;
  const bridge: FakeBridge = {
    db,
    paths,
    openRequestCalls: 0,
    listCalls: [],
    files: Object.assign(base, {
      async list(dir: string): Promise<BridgeFileListing> {
        bridge.listCalls.push(dir);
        if (failList) {
          failList = false;
          throw bridgeError("unavailable");
        }
        for (const write of base.writes) paths.add(write.path);
        const prefix = dir === "" ? "" : `${dir}/`;
        const children = new Map<string, BridgeFileEntry>();
        for (const path of paths) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const [name, ...more] = rest.split("/");
          if (name === undefined || name === "") continue;
          const kind = more.length > 0 ? "dir" : "file";
          children.set(name, { name, path: `${prefix}${name}`, kind, size: 0, modifiedAt: "2026-11-20T09:00:00.000Z" });
        }
        const entries = [...children.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
        return { entries, truncated: false } as BridgeFileListing;
      },
      async openRequest(): Promise<OpenRequest | null> {
        bridge.openRequestCalls++;
        const value = pending;
        pending = null;
        return value;
      },
      onOpenRequest(callback: (request: OpenRequest) => void): () => void {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      async mkdir(path: string) {
        return { path };
      },
    }),
    sendOpenRequest(path: string) {
      const value = request(path);
      for (const listener of [...listeners]) listener(value);
    },
    failListOnce() {
      failList = true;
    },
  };
  const ai = { routes: async () => ({ routes: [], defaultRoute: null }), generate: async () => ({ text: "" }) };
  (window as unknown as { MatrixOS: unknown }).MatrixOS = { app: { name: "docs" }, files: bridge.files, db, ai };
  return bridge;
}

export function renderApp() {
  return render(
    <StrictMode>
      <App author={OWNER} autosave={false} />
    </StrictMode>,
  );
}

/** The editing surface once a document is open. */
export async function findSurface(): Promise<HTMLElement> {
  return screen.findByRole("textbox", { name: "Document" });
}

/** The document name in the title bar (the open document's, else the app's). */
export function titleText(): string {
  const name = document.querySelector(".oui-doc-title__heading")?.getAttribute("aria-label");
  return name ?? document.querySelector(".oui-frame__title")?.textContent ?? "";
}

/** Opens a File (backstage) entry of the ribbon. */
export function fileMenu(item: string | RegExp): void {
  fireEvent.click(screen.getByRole("tab", { name: "File" }));
  fireEvent.click(screen.getByRole("button", { name: item }));
}

/** Puts the DOM caret at the end of the document when it is not already inside it, as a click would. */
export function placeCaretAtEnd(surface: HTMLElement): void {
  const selection = document.getSelection();
  if (selection === null) return;
  if (selection.rangeCount > 0 && surface.contains(selection.anchorNode)) return;
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) last = node;
  if (last === null) {
    const paragraph = surface.querySelector("[data-block-type='paragraph']") ?? surface;
    selection.collapse(paragraph, 0);
  } else selection.collapse(last, last.textContent?.length ?? 0);
  document.dispatchEvent(new Event("selectionchange"));
}

export function typeInto(surface: HTMLElement, text: string): void {
  placeCaretAtEnd(surface);
  for (const character of text) {
    surface.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: character, bubbles: true, cancelable: true }));
  }
}
