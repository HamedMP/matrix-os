// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalChatgptSubscription } from '../../packages/ui/src/agents-providers/LocalChatgptSubscription';
import type { LocalChatgptPlanClient, LocalChatgptPlanStatus } from '../../packages/ui/src/agents-providers/local-chatgpt-plan-client';
afterEach(cleanup);
it('offers explicit replacement with consequence copy and refreshes models only after recovery', async () => {
 const status: LocalChatgptPlanStatus = { state: 'connected', scope: 'this_device', account: { id: 'account', label: 'Personal' }, models: [{ id: 'gpt', displayName: 'GPT' }], grant: { revision: 1, enabled: true, background: false }, bridgeConnected: false, bridgeFailure: 'device_conflict', revocation: 'none' };
 const rebind = vi.fn(async () => ({ ...status, bridgeConnected: true, bridgeFailure: undefined }));
 const client = { status: vi.fn(async () => status), rebind } as unknown as LocalChatgptPlanClient;
 const changed = vi.fn(); render(<LocalChatgptSubscription client={client} disabled={false} readOnly={false} onChanged={changed}/>);
 const button = await screen.findByRole('button', { name: 'Use this device' });
 expect(screen.getByText(/Another device is connected/)).toBeTruthy(); expect(rebind).not.toHaveBeenCalled();
 fireEvent.click(button); fireEvent.click(button);
 await waitFor(() => expect(changed).toHaveBeenCalledTimes(1)); expect(rebind).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('button', { name: 'Use this device' })).toBeNull();
});
