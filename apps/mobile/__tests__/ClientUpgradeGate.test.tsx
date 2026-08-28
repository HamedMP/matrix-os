import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ClientUpgradeGate } from '../components/ClientUpgradeGate';
import { Text } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
const mockRead = jest.fn();
const mockCreateReader = jest.fn((_options: unknown) => ({ read: (...args: unknown[]) => mockRead(...args) }));
jest.mock('@matrix-os/contracts', () => ({
  createClientPolicyReader: (options: unknown) => mockCreateReader(options),
  evaluateClientPolicy: (policy: unknown) => policy ? 'required' : 'unknown',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.0' }));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
describe('mobile client upgrade gate', () => {
  it('keeps the store update action accessible when an upgrade is required', async () => {
    mockRead.mockResolvedValue({ policy: { downloadUrl: 'https://apps.apple.com/app/id123', latestVersion: '2.0.0' } });
    render(<ClientUpgradeGate origin="https://app.matrix-os.com"><Text>Workspace</Text></ClientUpgradeGate>);
    await waitFor(() => expect(screen.getByText('Update Matrix OS to continue')).toBeTruthy());
    expect(screen.queryByText('Workspace')).toBeNull();
    expect(screen.getByText('Open app store')).toBeTruthy();
    expect(mockCreateReader).toHaveBeenCalledWith(expect.objectContaining({ fetchFn: expoFetch }));
  });
  it('does not require an update when no policy has been published', async () => {
    mockRead.mockResolvedValue({ policy: null });
    render(<ClientUpgradeGate origin="https://app.matrix-os.com"><Text>Workspace</Text></ClientUpgradeGate>);
    await waitFor(() => expect(screen.getByText('Workspace')).toBeTruthy());
  });
  it('keeps sign-in and connection recovery reachable below the minimum', async () => {
    mockRead.mockResolvedValue({ policy: { downloadUrl: 'https://apps.apple.com/app/id123' } });
    render(<ClientUpgradeGate origin="https://app.matrix-os.com" allowRecovery><Text>Sign in</Text></ClientUpgradeGate>);
    await waitFor(() => expect(screen.getByText('Sign in')).toBeTruthy());
    expect(screen.queryByText('Update Matrix OS to continue')).toBeNull();
  });
});
