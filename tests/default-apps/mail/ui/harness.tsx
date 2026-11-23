import { act, render } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";
import { ToastProvider } from "../../../../home/apps/_shared/office-ui";
import type { ThreadSummary } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { createMailStore, noMailCache, type MailStore } from "../../../../home/apps/mail/src/model";
import type { MailBridge } from "../../../../home/apps/mail/src/ui/context";
import { MailWorkspace } from "../../../../home/apps/mail/src/ui/MailWorkspace";
import { FakeProvider } from "../model/fake-provider";
import { GMAIL, GMAIL_FOLDERS } from "../model/fixtures";

export const NOW = Date.parse("2026-11-10T21:00:00Z");

export interface Harness {
  store: MailStore;
  provider: FakeProvider;
  bridge: MailBridge & { data: Record<string, unknown> };
}

export function fakeBridge(): Harness["bridge"] {
  const data: Record<string, unknown> = {};
  return {
    data,
    readData: vi.fn(async (key: string) => data[key] ?? null),
    writeData: vi.fn(async (key: string, value: unknown) => {
      data[key] = value;
    }),
  };
}

/** A started store over one fake Gmail account whose inbox holds `inbox`, rendered in the workspace. */
export async function renderWorkspace(inbox: ThreadSummary[], setup?: (provider: FakeProvider) => void): Promise<Harness & ReturnType<typeof render>> {
  const provider = new FakeProvider(GMAIL_FOLDERS);
  provider.pageSize = 50;
  provider.lists.INBOX = inbox;
  setup?.(provider);
  const entries = [{ account: GMAIL, provider }];
  const store = createMailStore({ accounts: entries, cache: noMailCache, now: () => NOW, timeZone: "UTC", pageSize: 50 });
  const bridge = fakeBridge();
  const view = render(
    <ToastProvider>
      <MailWorkspace store={store} entries={entries} bridge={bridge} now={() => NOW} timeZone="UTC" />
    </ToastProvider>,
  );
  await act(async () => {
    await store.start();
  });
  return { store, provider, bridge, ...view };
}

/** A minimal DataTransfer for drag events in jsdom. */
export function dataTransfer(): DataTransfer {
  const data: Record<string, string> = {};
  const types: string[] = [];
  return {
    types,
    effectAllowed: "all",
    dropEffect: "none",
    setData(type: string, value: string) {
      if (!types.includes(type)) types.push(type);
      data[type] = value;
    },
    getData(type: string) {
      return data[type] ?? "";
    },
  } as unknown as DataTransfer;
}
