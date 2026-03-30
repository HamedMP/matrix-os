import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createActivityService,
  type ActivityService,
  type SocialConfig,
  DEFAULT_SOCIAL_CONFIG,
  loadSocialConfig,
  generateWeeklySummary,
} from '../../packages/gateway/src/social-activity.js';

describe('gateway/social-activity', () => {
  let tmpDir: string;
  let postCreated: Array<{ authorId: string; content: string; type: string; appRef?: string }>;
  let service: ActivityService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'social-activity-'));
    mkdirSync(join(tmpDir, 'system'), { recursive: true });
    postCreated = [];
    service = createActivityService({
      homePath: tmpDir,
      createPost: async (post) => {
        postCreated.push(post);
        return `post_${postCreated.length}`;
      },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('DEFAULT_SOCIAL_CONFIG', () => {
    it('has all sharing disabled by default', () => {
      expect(DEFAULT_SOCIAL_CONFIG.share_app_publishes).toBe(false);
      expect(DEFAULT_SOCIAL_CONFIG.share_app_forks).toBe(false);
      expect(DEFAULT_SOCIAL_CONFIG.share_game_scores).toBe(false);
      expect(DEFAULT_SOCIAL_CONFIG.share_ai_activity).toBe(false);
      expect(DEFAULT_SOCIAL_CONFIG.share_profile_updates).toBe(false);
      expect(DEFAULT_SOCIAL_CONFIG.auto_post_frequency).toBe('none');
    });
  });

  describe('loadSocialConfig', () => {
    it('returns defaults when config file does not exist', () => {
      const config = loadSocialConfig(tmpDir);
      expect(config).toEqual(DEFAULT_SOCIAL_CONFIG);
    });

    it('returns defaults when config file has invalid JSON', () => {
      writeFileSync(
        join(tmpDir, 'system', 'social-config.json'),
        'not-valid-json!!!',
      );
      const config = loadSocialConfig(tmpDir);
      expect(config).toEqual(DEFAULT_SOCIAL_CONFIG);
    });

    it('merges partial config with defaults', () => {
      writeFileSync(
        join(tmpDir, 'system', 'social-config.json'),
        JSON.stringify({ share_game_scores: true }),
      );
      const config = loadSocialConfig(tmpDir);
      expect(config.share_game_scores).toBe(true);
      expect(config.share_app_publishes).toBe(false);
      expect(config.auto_post_frequency).toBe('none');
    });

    it('loads config from file', () => {
      const customConfig: SocialConfig = {
        ...DEFAULT_SOCIAL_CONFIG,
        share_app_publishes: true,
        share_game_scores: true,
      };
      writeFileSync(
        join(tmpDir, 'system', 'social-config.json'),
        JSON.stringify(customConfig),
      );

      const config = loadSocialConfig(tmpDir);
      expect(config.share_app_publishes).toBe(true);
      expect(config.share_game_scores).toBe(true);
      expect(config.share_ai_activity).toBe(false);
    });
  });

  describe('onAppPublish', () => {
    it('creates activity post when sharing is enabled', () => {
      writeFileSync(
        join(tmpDir, 'system', 'social-config.json'),
        JSON.stringify({ ...DEFAULT_SOCIAL_CONFIG, share_app_publishes: true }),
      );

      service.onAppPublish({ authorId: '@alice', appName: 'Snake', appId: 'app_001' });

      expect(postCreated).toHaveLength(1);
      expect(postCreated[0].type).toBe('activity');
      expect(postCreated[0].content).toContain('Snake');
      expect(postCreated[0].authorId).toBe('@alice');
    });

    it('does not create post when sharing is disabled', () => {
      service.onAppPublish({ authorId: '@alice', appName: 'Snake', appId: 'app_001' });
      expect(postCreated).toHaveLength(0);
    });
  });

  describe('onAppFork', () => {
    it('creates activity post when sharing is enabled', () => {
      writeFileSync(
        join(tmpDir, 'system', 'social-config.json'),
        JSON.stringify({ ...DEFAULT_SOCIAL_CONFIG, share_app_forks: true }),
      );

      service.onAppFork({
        authorId: '@bob',
        appName: 'Budget Tracker',
        originalAuthor: '@alice',
      });

      expect(postCreated).toHaveLength(1);
      expect(postCreated[0].content).toContain('Budget Tracker');
      expect(postCreated[0].content).toContain('@alice');
    });

    it('does not create post when sharing is disabled', () => {
      service.onAppFork({ authorId: '@bob', appName: 'Budget Tracker', originalAuthor: '@alice' });
      expect(postCreated).toHaveLength(0);
    });
  });

  describe('onGameScore (disabled)', () => {
    it('does not create post when sharing is disabled', () => {
      service.onGameScore({ authorId: '@alice', gameName: 'Snake', score: 500 });
      expect(postCreated).toHaveLength(0);
    });
  });

  describe('onGameScore', () => {
    it('creates activity post when sharing is enabled', () => {
      writeFileSync(
        join(tmpDir, 'system', 'social-config.json'),
        JSON.stringify({ ...DEFAULT_SOCIAL_CONFIG, share_game_scores: true }),
      );

      service.onGameScore({ authorId: '@alice', gameName: 'Snake', score: 1500 });

      expect(postCreated).toHaveLength(1);
      expect(postCreated[0].content).toContain('Snake');
      expect(postCreated[0].content).toContain('1500');
    });
  });

  describe('onAiActivity (disabled)', () => {
    it('does not create post when sharing is disabled', () => {
      service.onAiActivity({ authorId: '@alice', description: 'helped build something' });
      expect(postCreated).toHaveLength(0);
    });
  });

  describe('onAiActivity', () => {
    it('creates activity post when sharing is enabled', () => {
      writeFileSync(
        join(tmpDir, 'system', 'social-config.json'),
        JSON.stringify({ ...DEFAULT_SOCIAL_CONFIG, share_ai_activity: true }),
      );

      service.onAiActivity({
        authorId: '@alice',
        description: 'helped build a dashboard',
      });

      expect(postCreated).toHaveLength(1);
      expect(postCreated[0].content).toContain('dashboard');
    });
  });

  describe('generateWeeklySummary', () => {
    it('generates summary content from stats', () => {
      const summary = generateWeeklySummary({
        appsBuilt: 3,
        gamesPlayed: 2,
        aiInteractions: 12,
        filesCreated: 45,
      });

      expect(summary).toContain('3');
      expect(summary).toContain('week');
    });

    it('uses singular form for counts of 1', () => {
      const summary = generateWeeklySummary({
        appsBuilt: 1,
        gamesPlayed: 1,
        aiInteractions: 1,
        filesCreated: 1,
      });

      expect(summary).toContain('1 app,');
      expect(summary).toContain('1 game,');
      expect(summary).toContain('1 AI interaction,');
      expect(summary).toContain('1 file');
      expect(summary).not.toContain('apps');
      expect(summary).not.toContain('games');
      expect(summary).not.toContain('interactions');
      expect(summary).not.toContain('files');
    });

    it('includes only non-zero stats', () => {
      const summary = generateWeeklySummary({
        appsBuilt: 2,
        gamesPlayed: 0,
        aiInteractions: 5,
        filesCreated: 0,
      });

      expect(summary).toContain('2 apps');
      expect(summary).toContain('5 AI interactions');
      expect(summary).not.toContain('game');
      expect(summary).not.toContain('file');
    });

    it('generates empty summary when no activity', () => {
      const summary = generateWeeklySummary({
        appsBuilt: 0,
        gamesPlayed: 0,
        aiInteractions: 0,
        filesCreated: 0,
      });

      expect(summary).toContain('quiet week');
    });
  });
});
