import { describe, it, expect } from 'vitest';
import {
  AppManifestSchema,
  IntegrationsSchema,
  DistributionSchema,
  ForkedFromSchema,
  InstalledFromSchema,
  parseAppManifest,
} from '../../../packages/gateway/src/app-manifest.js';

describe('gateway/app-manifest-v2', () => {
  describe('IntegrationsSchema', () => {
    it('parses required and optional arrays', () => {
      const result = IntegrationsSchema.parse({
        required: ['gmail.read', 'calendar.write'],
        optional: ['slack.send'],
      });
      expect(result.required).toEqual(['gmail.read', 'calendar.write']);
      expect(result.optional).toEqual(['slack.send']);
    });

    it('allows empty object', () => {
      const result = IntegrationsSchema.parse({});
      expect(result.required).toBeUndefined();
      expect(result.optional).toBeUndefined();
    });

    it('allows only required', () => {
      const result = IntegrationsSchema.parse({ required: ['gmail.read'] });
      expect(result.required).toEqual(['gmail.read']);
      expect(result.optional).toBeUndefined();
    });

    it('allows only optional', () => {
      const result = IntegrationsSchema.parse({ optional: ['slack.send'] });
      expect(result.required).toBeUndefined();
      expect(result.optional).toEqual(['slack.send']);
    });
  });

  describe('DistributionSchema', () => {
    it('parses public visibility', () => {
      const result = DistributionSchema.parse({ visibility: 'public' });
      expect(result.visibility).toBe('public');
      expect(result.org_id).toBeUndefined();
    });

    it('parses organization visibility with org_id', () => {
      const result = DistributionSchema.parse({
        visibility: 'organization',
        org_id: 'org-123',
      });
      expect(result.visibility).toBe('organization');
      expect(result.org_id).toBe('org-123');
    });

    it('parses unlisted visibility', () => {
      const result = DistributionSchema.parse({ visibility: 'unlisted' });
      expect(result.visibility).toBe('unlisted');
    });

    it('parses full distribution with all fields', () => {
      const result = DistributionSchema.parse({
        visibility: 'public',
        org_id: 'org-123',
        published_at: '2026-04-05T00:00:00Z',
        listing_id: 'listing-456',
      });
      expect(result.published_at).toBe('2026-04-05T00:00:00Z');
      expect(result.listing_id).toBe('listing-456');
    });

    it('rejects invalid visibility', () => {
      expect(() => DistributionSchema.parse({ visibility: 'private' })).toThrow();
    });

    it('requires visibility field', () => {
      expect(() => DistributionSchema.parse({})).toThrow();
    });
  });

  describe('ForkedFromSchema', () => {
    it('parses fork metadata', () => {
      const result = ForkedFromSchema.parse({
        author: 'alice',
        slug: 'snake-game',
        version: '1.0.0',
      });
      expect(result.author).toBe('alice');
      expect(result.slug).toBe('snake-game');
      expect(result.version).toBe('1.0.0');
    });
  });

  describe('InstalledFromSchema', () => {
    it('parses install metadata', () => {
      const result = InstalledFromSchema.parse({
        slug: 'snake-game',
        installedAt: '2026-04-05T00:00:00Z',
        listing_id: 'listing-123',
        version_id: 'version-456',
      });
      expect(result.slug).toBe('snake-game');
      expect(result.listing_id).toBe('listing-123');
      expect(result.version_id).toBe('version-456');
    });

    it('allows minimal install metadata', () => {
      const result = InstalledFromSchema.parse({
        slug: 'snake-game',
        installedAt: '2026-04-05T00:00:00Z',
      });
      expect(result.slug).toBe('snake-game');
      expect(result.listing_id).toBeUndefined();
      expect(result.version_id).toBeUndefined();
    });
  });

  describe('AppManifestSchema v2 fields', () => {
    const baseManifest = { name: 'Test App' };

    it('parses a v1 manifest unchanged', () => {
      const result = AppManifestSchema.parse(baseManifest);
      expect(result.name).toBe('Test App');
      expect(result.permissions).toEqual([]);
      expect(result.integrations).toBeUndefined();
      expect(result.distribution).toBeUndefined();
      expect(result.forked_from).toBeUndefined();
      expect(result.installed_from).toBeUndefined();
    });

    it('parses manifest with integrations', () => {
      const result = AppManifestSchema.parse({
        ...baseManifest,
        integrations: {
          required: ['gmail.read'],
          optional: ['slack.send'],
        },
      });
      expect(result.integrations!.required).toEqual(['gmail.read']);
      expect(result.integrations!.optional).toEqual(['slack.send']);
    });

    it('parses manifest with distribution', () => {
      const result = AppManifestSchema.parse({
        ...baseManifest,
        distribution: {
          visibility: 'public',
          published_at: '2026-04-05T00:00:00Z',
          listing_id: 'listing-123',
        },
      });
      expect(result.distribution!.visibility).toBe('public');
      expect(result.distribution!.listing_id).toBe('listing-123');
    });

    it('parses manifest with permissions', () => {
      const result = AppManifestSchema.parse({
        ...baseManifest,
        permissions: ['fs.read', 'net.fetch'],
      });
      expect(result.permissions).toEqual(['fs.read', 'net.fetch']);
    });

    it('parses manifest with forked_from', () => {
      const result = AppManifestSchema.parse({
        ...baseManifest,
        forked_from: { author: 'alice', slug: 'snake', version: '1.0.0' },
      });
      expect(result.forked_from!.author).toBe('alice');
    });

    it('parses manifest with installed_from', () => {
      const result = AppManifestSchema.parse({
        ...baseManifest,
        installed_from: {
          slug: 'snake',
          installedAt: '2026-04-05T00:00:00Z',
          listing_id: 'lst-1',
          version_id: 'ver-1',
        },
      });
      expect(result.installed_from!.listing_id).toBe('lst-1');
    });

    it('parses a full manifest with all v2 fields', () => {
      const full = {
        name: 'Super App',
        description: 'A super app',
        runtime: 'node' as const,
        entry: 'index.js',
        port: 3100,
        framework: 'express',
        permissions: ['fs.read', 'net.fetch'],
        resources: { memory: '256m', cpu: 0.5 },
        category: 'productivity',
        icon: '/icons/super.png',
        author: 'alice',
        version: '2.0.0',
        autoStart: true,
        storage: { tables: {} },
        integrations: { required: ['gmail.read'], optional: ['slack.send'] },
        distribution: { visibility: 'organization' as const, org_id: 'org-1' },
        forked_from: { author: 'bob', slug: 'base-app', version: '1.0.0' },
        installed_from: { slug: 'super-app', installedAt: '2026-04-05T00:00:00Z' },
      };

      const result = AppManifestSchema.parse(full);
      expect(result.name).toBe('Super App');
      expect(result.integrations!.required).toEqual(['gmail.read']);
      expect(result.distribution!.visibility).toBe('organization');
      expect(result.forked_from!.author).toBe('bob');
      expect(result.installed_from!.slug).toBe('super-app');
    });

    it('parseAppManifest works with v2 fields', () => {
      const result = parseAppManifest({
        name: 'Test',
        integrations: { required: ['gmail.read'] },
        distribution: { visibility: 'public' },
      });
      expect(result.integrations!.required).toEqual(['gmail.read']);
      expect(result.distribution!.visibility).toBe('public');
    });
  });
});
