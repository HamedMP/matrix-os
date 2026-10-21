import React from 'react';
import { render as renderActual } from '@testing-library/react';
import { vi } from 'vitest';
import type { CanonicalChatClient } from '@desktop/renderer/src/lib/canonical-chat-client';
/** Legacy test clients explicitly prove ordinary binding and full-detail reads. */
function prepare(node: React.ReactNode): void {
  if (!React.isValidElement(node))
    return;
  const props = node.props as {
    client?: CanonicalChatClient;
    children?: React.ReactNode;
  };
  const client = props.client;
  if (client) {
    client.agents ??= { list: vi.fn(async () => ({ enabled: true, agents: [] })), bots: { directChat: vi.fn(async () => null), directBot: vi.fn(async () => null), interactions: vi.fn(async () => []) } } as unknown as NonNullable<CanonicalChatClient['agents']>;
    client.getDetail ??= vi.fn(async (id) => {
      const response = await vi.mocked(client.list).mock.results.at(-1)?.value;
      const record = response?.items.find((item: {
        chat: {
          id: string;
        };
      }) => item.chat.id === id);
      if (!record)
        throw new Error('Missing detail fixture');
      return { record, messages: [], turns: [], runs: [], approvals: [] };
    });
  }
  React.Children.forEach(props.children, prepare);
}
export function renderRailFixture(node: React.ReactElement) {
  prepare(node);
  const view = renderActual(node);
  const rerender = view.rerender;
  return { ...view, rerender: (next: React.ReactElement) => { prepare(next); rerender(next); } };
}
