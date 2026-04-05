import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useParams: () => ({ orgSlug: 'test-org', slug: 'test-app' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

// Mock gateway URL
vi.mock('@/lib/gateway', () => ({
  getGatewayUrl: () => 'http://localhost:4000',
}));

describe('OrgPicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no userId provided', async () => {
    const { OrgPicker } = await import(
      '../../../../shell/src/components/app-store/OrgPicker'
    );
    const { container } = render(
      <OrgPicker value={null} onChange={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('fetches and renders orgs when userId provided', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        orgs: [
          { id: '1', slug: 'org-1', name: 'Org One', memberCount: 3, role: 'owner' },
          { id: '2', slug: 'org-2', name: 'Org Two', memberCount: 5, role: 'member' },
        ],
      }),
    });

    const { OrgPicker } = await import(
      '../../../../shell/src/components/app-store/OrgPicker'
    );
    const onChange = vi.fn();
    render(<OrgPicker value={null} onChange={onChange} userId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText('Org One')).toBeTruthy();
      expect(screen.getByText('Org Two')).toBeTruthy();
    });
  });

  it('shows loading state', async () => {
    let resolvePromise: (value: unknown) => void;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    global.fetch = vi.fn().mockReturnValueOnce(promise);

    const { OrgPicker } = await import(
      '../../../../shell/src/components/app-store/OrgPicker'
    );
    render(<OrgPicker value={null} onChange={() => {}} userId="user-1" />);

    expect(screen.getByText('Loading organizations...')).toBeTruthy();

    resolvePromise!({
      ok: true,
      json: async () => ({ orgs: [] }),
    });
  });
});

describe('MyOrgsSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no userId', async () => {
    const { MyOrgsSection } = await import(
      '../../../../shell/src/components/app-store/MyOrgsSection'
    );
    const { container } = render(<MyOrgsSection />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when user has no orgs', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ orgs: [] }),
    });

    const { MyOrgsSection } = await import(
      '../../../../shell/src/components/app-store/MyOrgsSection'
    );
    const { container } = render(<MyOrgsSection userId="user-1" />);

    await waitFor(() => {
      expect(container.querySelector('section')).toBeNull();
    });
  });

  it('renders orgs with apps', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          orgs: [
            { id: '1', slug: 'my-org', name: 'My Org', memberCount: 2, role: 'owner' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          apps: [
            { id: 'a1', slug: 'app-1', name: 'App One', description: 'First app', iconUrl: null },
          ],
        }),
      });

    const { MyOrgsSection } = await import(
      '../../../../shell/src/components/app-store/MyOrgsSection'
    );
    render(<MyOrgsSection userId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText('My Organizations')).toBeTruthy();
      expect(screen.getByText('My Org')).toBeTruthy();
      expect(screen.getByText('App One')).toBeTruthy();
    });
  });
});

describe('OrgAppPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', async () => {
    let resolvePromise: (value: unknown) => void;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    global.fetch = vi.fn().mockReturnValueOnce(promise);

    const OrgAppPage = (
      await import('../../../../shell/src/app/o/[orgSlug]/a/[slug]/page')
    ).default;
    render(<OrgAppPage />);

    expect(screen.getByText('Loading...')).toBeTruthy();

    resolvePromise!({
      ok: true,
      json: async () => ({
        apps: [{ id: '1', slug: 'test-app', name: 'Test', description: null, category: 'utility', iconUrl: null, installsCount: 0, avgRating: '0.0', ratingsCount: 0 }],
      }),
    });
  });

  it('renders app details on success', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        apps: [
          {
            id: '1',
            slug: 'test-app',
            name: 'Test App',
            description: 'A test app',
            category: 'utility',
            iconUrl: null,
            installsCount: 42,
            avgRating: '4.5',
            ratingsCount: 10,
          },
        ],
      }),
    });

    const OrgAppPage = (
      await import('../../../../shell/src/app/o/[orgSlug]/a/[slug]/page')
    ).default;
    render(<OrgAppPage />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeTruthy();
      expect(screen.getByText('A test app')).toBeTruthy();
      expect(screen.getByText('42 installs')).toBeTruthy();
    });
  });

  it('shows error for non-member', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
    });

    const OrgAppPage = (
      await import('../../../../shell/src/app/o/[orgSlug]/a/[slug]/page')
    ).default;
    render(<OrgAppPage />);

    await waitFor(() => {
      expect(screen.getByText('Access Denied')).toBeTruthy();
    });
  });
});
