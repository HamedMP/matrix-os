// @vitest-environment jsdom
import React, { startTransition, Suspense, useState } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { clearChatNavigationScopes, useChatNavigation } from '../../packages/ui/src/chat-navigation/use-chat-navigation.js';
afterEach(() => { cleanup(); clearChatNavigationScopes(); });
const empty = { version: 1 as const, items: [], truncated: false };
it('shares one loader and one event subscription across mounted surfaces', async () => {
  const load = vi.fn(async () => empty);
  let emit!: (event: unknown) => void;
  const dispose = vi.fn();
  const events = { subscribe: vi.fn(listener => { emit = listener; return { dispose }; }) };
  const first = renderHook(() => useChatNavigation({ scope: 'same', load, eventSource: events }));
  const second = renderHook(() => useChatNavigation({ scope: 'same', load, eventSource: events }));
  await waitFor(() => expect(first.result.current.fresh).toBe(true));
  expect(load).toHaveBeenCalledTimes(1);
  expect(events.subscribe).toHaveBeenCalledTimes(1);
  act(() => emit({ type: 'chat.changed', chatId: 'chat_one', cursor: 1, revision: 1, eventType: 'chat.updated' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  first.unmount();
  expect(dispose).not.toHaveBeenCalled();
  second.unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
});
it('does not replace the committed authority or loader from an abandoned concurrent render', async () => {
  const original = vi.fn(async () => empty);
  const speculative = vi.fn(async () => empty);
  let change!: (next: boolean) => void;
  let refresh!: (() => Promise<void>);
  const pending = new Promise(() => { });
  function Consumer({ next }: {
    next: boolean;
  }) {
    const value = useChatNavigation({ scope: 'owner', generation: next ? 'new' : 'old', load: next ? speculative : original });
    if (next)
      throw pending;
    refresh = () => value.store!.refresh();
    return <output>{value.status}</output>;
  }
  function Host() { const [next, setNext] = useState(false); change = setNext; return <Suspense fallback='waiting'><Consumer next={next}/></Suspense>; }
  const view = render(<Host />);
  await waitFor(() => expect(view.container.textContent).toBe('ready'));
  await act(async () => startTransition(() => change(true)));
  await act(async () => refresh());
  expect(original).toHaveBeenCalledTimes(2);
  expect(speculative).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe('ready');
});
it('keeps a recently revisited inactive scope when evicting at the memory cap', async () => {
  const loaders = Array.from({ length: 4 }, () => vi.fn(async () => empty));
  const mount = async (index: number) => {
    const hook = renderHook(() => useChatNavigation({ scope: `lru-${index}`, load: loaders[index]! }));
    await waitFor(() => expect(hook.result.current.fresh).toBe(true));
    hook.unmount();
  };
  await mount(0);
  await mount(1);
  await mount(2);
  await mount(0);
  await mount(3);
  await mount(0);
  expect(loaders[0]).toHaveBeenCalledTimes(1);
  await mount(1);
  expect(loaders[1]).toHaveBeenCalledTimes(2);
});
it('retains a shared event source at the source cap until its last surface unmounts', async () => {
  const load = vi.fn(async () => empty);
  const sources = Array.from({ length: 16 }, () => ({ subscribe: vi.fn(() => ({ dispose: vi.fn() })) }));
  const surfaces = sources.map(eventSource => renderHook(() => useChatNavigation({ scope: 'source-cap', load, eventSource })));
  const repeated = renderHook(() => useChatNavigation({ scope: 'source-cap', load, eventSource: sources[0] }));
  await waitFor(() => expect(repeated.result.current.fresh).toBe(true));
  const connection = sources[0]!.subscribe.mock.results[0]!.value;
  surfaces[0]!.unmount();
  expect(connection.dispose).not.toHaveBeenCalled();
  repeated.unmount();
  expect(connection.dispose).toHaveBeenCalledOnce();
});
it('revalidates when recovery replay ends while an older cold snapshot is pending', async () => {
  let release!: (value: typeof empty) => void;
  const pending = new Promise<typeof empty>(resolve => { release = resolve; });
  const load = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(empty);
  let emit!: (event: unknown) => void;
  const events = { subscribe: (listener: typeof emit) => { emit = listener; return { dispose() {} }; } };
  const hook = renderHook(() => useChatNavigation({ scope: 'recovery', load, eventSource: events }));
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  act(() => emit({ type: 'chat.full_refresh', cursor: 3 }));
  await act(async () => { release(empty); });
  await waitFor(() => expect(hook.result.current.fresh).toBe(true));
  expect(load).toHaveBeenCalledTimes(2);
});
