import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { agentInspirations } from '../../packages/ui/src/chat-agents/agent-inspirations.generated';

interface InventoryBot {
  id: string;
  name: string;
  sourceUrl: string;
  promptSurface: { memoryCount: number; memoryContentSha256: string };
  skills: { count: number };
  routines: { count: number };
  integrations: { count: number };
}

interface MarketplaceInventory {
  schemaVersion: number;
  fingerprintEvidence: { status: string; reproducible: boolean; limitation: string };
  botCount: number;
  bots: InventoryBot[];
}

describe('xAI marketplace research inventory', () => {
  it('persists the complete, internally consistent 2026-09-11 catalogue', async () => {
    const raw = await readFile(
      new URL('../../specs/121-chat-agent-templates/xai-marketplace-inventory.json', import.meta.url),
      'utf8',
    );
    const inventory = JSON.parse(raw) as MarketplaceInventory;

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.fingerprintEvidence.status).toBe('historical-unverified');
    expect(inventory.fingerprintEvidence.reproducible).toBe(false);
    expect(inventory.fingerprintEvidence.limitation).toContain('serialization');
    expect(inventory.botCount).toBe(71);
    expect(inventory.bots).toHaveLength(inventory.botCount);
    expect(new Set(inventory.bots.map((bot) => bot.id)).size).toBe(inventory.botCount);
    expect(new Set(inventory.bots.map((bot) => bot.sourceUrl)).size).toBe(inventory.botCount);
    expect(inventory.bots.every((bot) => bot.sourceUrl.endsWith(`/${bot.id}`))).toBe(true);
    expect(inventory.bots.reduce((sum, bot) => sum + bot.promptSurface.memoryCount, 0)).toBe(446);
    expect(inventory.bots.reduce((sum, bot) => sum + bot.skills.count, 0)).toBe(286);
    expect(inventory.bots.reduce((sum, bot) => sum + bot.routines.count, 0)).toBe(110);
    expect(inventory.bots.reduce((sum, bot) => sum + bot.integrations.count, 0)).toBe(268);
    expect(inventory.bots.every((bot) => /^[a-f0-9]{64}$/.test(bot.promptSurface.memoryContentSha256))).toBe(true);
    expect(agentInspirations.map((recipe) => recipe.id)).toEqual(inventory.bots.map((bot) => bot.id));
    expect(agentInspirations.every((recipe) => recipe.description && Array.isArray(recipe.skills))).toBe(true);
  });
});
