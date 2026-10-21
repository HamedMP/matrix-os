// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalChatgptSubscription } from '../../packages/ui/src/agents-providers/LocalChatgptSubscription';
import type { LocalChatgptPlanClient, LocalChatgptPlanStatus } from '../../packages/ui/src/agents-providers/local-chatgpt-plan-client';
afterEach(() => { cleanup(); vi.useRealTimers(); });
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

const conflict: LocalChatgptPlanStatus = { state: 'connected', scope: 'this_device', account: { id: 'account', label: 'Personal' }, models: [{ id: 'gpt', displayName: 'GPT' }], grant: { revision: 1, enabled: true, background: false }, bridgeConnected: false, bridgeFailure: 'device_conflict', revocation: 'none' };
const waiting = { ...conflict, bridgeFailure: undefined };
const ready = { ...waiting, bridgeConnected: true };
function failedRecovery() {
 const status = vi.fn().mockResolvedValue(conflict);
 const rebind = vi.fn().mockRejectedValue(new Error('unavailable'));
 return { status, rebind, client: { status, rebind } as unknown as LocalChatgptPlanClient };
}
it('rereads failed recovery and polls the cleared native conflict through background success', async () => {
 const x=failedRecovery(), changed=vi.fn();x.status.mockResolvedValueOnce(conflict).mockResolvedValueOnce(waiting).mockResolvedValue(ready);
 render(<LocalChatgptSubscription client={x.client} disabled={false} readOnly={false} onChanged={changed}/>);
 const button=await screen.findByRole('button',{name:'Use this device'});vi.useFakeTimers();
 await act(async()=>{fireEvent.click(button);});
 expect(x.status).toHaveBeenCalledTimes(2);expect(screen.queryByRole('button',{name:'Use this device'})).toBeNull();
 expect(screen.getByRole('alert')).toBeTruthy();expect(changed).not.toHaveBeenCalled();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 expect(screen.getByText(/Available for chats and interactive/)).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
 expect(changed).toHaveBeenCalledOnce();expect(x.rebind).toHaveBeenCalledOnce();
});
it('keeps a freshly confirmed conflict actionable after failed recovery',async()=>{
 const x=failedRecovery(),changed=vi.fn();render(<LocalChatgptSubscription client={x.client} disabled={false} readOnly={false} onChanged={changed}/>);
 const button=await screen.findByRole('button',{name:'Use this device'});
 fireEvent.click(button);await waitFor(()=>expect(x.status).toHaveBeenCalledTimes(2));
 expect(screen.getByRole('alert')).toBeTruthy();expect(screen.getByRole('button',{name:'Use this device'})).toBeTruthy();expect(changed).not.toHaveBeenCalled();expect(x.rebind).toHaveBeenCalledOnce();
});
it('preserves safe error when reconciliation fails and retries via existing Settings refresh',async()=>{
 const x=failedRecovery(),changed=vi.fn();x.status.mockResolvedValueOnce(conflict).mockRejectedValueOnce(new Error('status unavailable')).mockResolvedValue(ready);
 const view=render(<LocalChatgptSubscription client={x.client} disabled={false} readOnly={false} onChanged={changed}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Use this device'}));await waitFor(()=>expect(x.status).toHaveBeenCalledTimes(2));
 expect(screen.getByRole('alert')).toBeTruthy();expect(changed).not.toHaveBeenCalled();
 view.rerender(<LocalChatgptSubscription client={x.client} disabled={false} readOnly={false} refreshRevision={1} onChanged={changed}/>);
 await screen.findByText(/Available for chats and interactive/);expect(screen.queryByRole('alert')).toBeNull();expect(x.rebind).toHaveBeenCalledOnce();
});
it('discards delayed failed-recovery reconciliation after the client scope changes',async()=>{
 const x=failedRecovery(),changed=vi.fn();let release!:(value:LocalChatgptPlanStatus)=>void;
 x.status.mockResolvedValueOnce(conflict).mockImplementationOnce(()=>new Promise<LocalChatgptPlanStatus>(resolve=>{release=resolve;}));
 const view=render(<LocalChatgptSubscription client={x.client} disabled={false} readOnly={false} onChanged={changed}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Use this device'}));await waitFor(()=>expect(x.status).toHaveBeenCalledTimes(2));
 const other={status:vi.fn(async()=>({...ready,account:{id:'new',label:'Other owner'}}))} as unknown as LocalChatgptPlanClient;
 view.rerender(<LocalChatgptSubscription client={other} disabled={false} readOnly={false} onChanged={changed}/>);
 await screen.findByText('Other owner');await act(async()=>{release(conflict);});
 expect(screen.getByText('Other owner')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByRole('button',{name:'Use this device'})).toBeNull();expect(changed).not.toHaveBeenCalled();
});
it('refreshes provider discovery immediately when failed-action reconciliation is already connected',async()=>{
 const x=failedRecovery(),changed=vi.fn();x.status.mockResolvedValueOnce(conflict).mockResolvedValue(ready);
 render(<LocalChatgptSubscription client={x.client} disabled={false} readOnly={false} onChanged={changed}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Use this device'}));
 await screen.findByText(/Available for chats and interactive/);
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByRole('button',{name:'Use this device'})).toBeNull();
 expect(changed).toHaveBeenCalledOnce();expect(x.status).toHaveBeenCalledTimes(2);expect(x.rebind).toHaveBeenCalledOnce();
});
