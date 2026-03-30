import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SocialConfig {
  share_app_publishes: boolean;
  share_app_forks: boolean;
  share_game_scores: boolean;
  share_ai_activity: boolean;
  share_profile_updates: boolean;
  auto_post_frequency: 'none' | 'weekly_summary';
}

export const DEFAULT_SOCIAL_CONFIG: SocialConfig = {
  share_app_publishes: false,
  share_app_forks: false,
  share_game_scores: false,
  share_ai_activity: false,
  share_profile_updates: false,
  auto_post_frequency: 'none',
};

export function loadSocialConfig(homePath: string): SocialConfig {
  const configPath = join(homePath, 'system', 'social-config.json');
  if (!existsSync(configPath)) {
    return { ...DEFAULT_SOCIAL_CONFIG };
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SOCIAL_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_SOCIAL_CONFIG };
  }
}

export interface ActivityServiceConfig {
  homePath: string;
  createPost: (post: {
    authorId: string;
    content: string;
    type: string;
    appRef?: string;
  }) => Promise<string>;
}

export interface ActivityService {
  onAppPublish(event: { authorId: string; appName: string; appId: string }): void;
  onAppFork(event: { authorId: string; appName: string; originalAuthor: string }): void;
  onGameScore(event: { authorId: string; gameName: string; score: number }): void;
  onAiActivity(event: { authorId: string; description: string }): void;
}

export function createActivityService(config: ActivityServiceConfig): ActivityService {
  const { homePath, createPost } = config;

  function getConfig(): SocialConfig {
    return loadSocialConfig(homePath);
  }

  return {
    onAppPublish(event) {
      const cfg = getConfig();
      if (!cfg.share_app_publishes) return;
      createPost({
        authorId: event.authorId,
        content: `Published a new app: ${event.appName}`,
        type: 'activity',
        appRef: event.appId,
      }).catch((e) => console.error('[social-activity] Failed to create post:', e));
    },

    onAppFork(event) {
      const cfg = getConfig();
      if (!cfg.share_app_forks) return;
      createPost({
        authorId: event.authorId,
        content: `Remixed ${event.originalAuthor}'s ${event.appName}`,
        type: 'activity',
      }).catch((e) => console.error('[social-activity] Failed to create post:', e));
    },

    onGameScore(event) {
      const cfg = getConfig();
      if (!cfg.share_game_scores) return;
      createPost({
        authorId: event.authorId,
        content: `Scored ${event.score} in ${event.gameName}!`,
        type: 'activity',
      }).catch((e) => console.error('[social-activity] Failed to create post:', e));
    },

    onAiActivity(event) {
      const cfg = getConfig();
      if (!cfg.share_ai_activity) return;
      createPost({
        authorId: event.authorId,
        content: `My AI ${event.description}`,
        type: 'activity',
      }).catch((e) => console.error('[social-activity] Failed to create post:', e));
    },
  };
}

export interface WeeklySummaryStats {
  appsBuilt: number;
  gamesPlayed: number;
  aiInteractions: number;
  filesCreated: number;
}

export function generateWeeklySummary(stats: WeeklySummaryStats): string {
  const parts: string[] = [];

  if (stats.appsBuilt > 0) {
    parts.push(`built ${stats.appsBuilt} app${stats.appsBuilt > 1 ? 's' : ''}`);
  }
  if (stats.gamesPlayed > 0) {
    parts.push(`played ${stats.gamesPlayed} game${stats.gamesPlayed > 1 ? 's' : ''}`);
  }
  if (stats.aiInteractions > 0) {
    parts.push(`had ${stats.aiInteractions} AI interaction${stats.aiInteractions > 1 ? 's' : ''}`);
  }
  if (stats.filesCreated > 0) {
    parts.push(`created ${stats.filesCreated} file${stats.filesCreated > 1 ? 's' : ''}`);
  }

  if (parts.length === 0) {
    return 'A quiet week on Matrix OS.';
  }

  return `My week on Matrix OS: ${parts.join(', ')}.`;
}
