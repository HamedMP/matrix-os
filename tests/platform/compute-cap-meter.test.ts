import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { loadComputeCapConfig } from '../../packages/platform/src/free-tier/config.js';
import {
  DEFAULT_COMPUTE_CAP_CONFIG,
  closeComputeInterval,
  monthStartUtc,
  nextMonthStartUtc,
  readComputeUsage,
} from '../../packages/platform/src/free-tier/compute-meter.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const HOUR = 3_600_000;

describe('compute cap configuration', () => {
  it('defaults to 80 hours, two export wakes, and fifteen-minute export windows', () => {
    expect(loadComputeCapConfig({})).toEqual({ capMs: 80 * HOUR, exportWakesPerMonth: 2, exportWindowMs: 15 * 60_000 });
    expect(DEFAULT_COMPUTE_CAP_CONFIG).toEqual(loadComputeCapConfig({}));
  });

  it('reads overrides once and keeps the defaults when a setting is invalid, naming it', () => {
    expect(loadComputeCapConfig({
      MATRIX_FREE_COMPUTE_CAP_HOURS: '40', MATRIX_FREE_EXPORT_WAKES_PER_MONTH: '1', MATRIX_FREE_EXPORT_WAKE_MINUTES: '10',
    })).toEqual({ capMs: 40 * HOUR, exportWakesPerMonth: 1, exportWindowMs: 10 * 60_000 });
    const logged: string[] = [];
    expect(loadComputeCapConfig({ MATRIX_FREE_COMPUTE_CAP_HOURS: 'lots', MATRIX_FREE_EXPORT_WAKE_MINUTES: '0' }, (line) => logged.push(line)))
      .toEqual(DEFAULT_COMPUTE_CAP_CONFIG);
    expect(logged).toEqual(['[platform] compute cap uses defaults; invalid settings: MATRIX_FREE_COMPUTE_CAP_HOURS, MATRIX_FREE_EXPORT_WAKE_MINUTES']);
  });
});

describe('UTC calendar months', () => {
  it('finds the month start and the next reset, across a year end', () => {
    expect(monthStartUtc(new Date('2026-11-30T23:59:59.999Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(nextMonthStartUtc(new Date('2026-11-14T10:00:00.000Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(nextMonthStartUtc(new Date('2026-12-31T23:00:00.000Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextMonthStartUtc(new Date('2026-12-01T00:00:00.000Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('owner-month compute rows', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('splits an interval across the month boundary into each month', async () => {
    await closeComputeInterval(db.executor, {
      clerkUserId: 'user_a', mode: 'full',
      openedAt: new Date('2026-11-30T23:00:00.000Z'), closedAt: new Date('2026-12-01T01:30:00.000Z'),
    });
    expect(await readComputeUsage(db.executor, 'user_a', new Date('2026-11-30T23:59:00.000Z')))
      .toEqual({ billedMs: HOUR, exportMs: 0, exportWakes: 0 });
    expect(await readComputeUsage(db.executor, 'user_a', new Date('2026-12-02T00:00:00.000Z')))
      .toEqual({ billedMs: 1.5 * HOUR, exportMs: 0, exportWakes: 0 });
  });

  it('adds export-only time to its own counter, never to billed time', async () => {
    const at = new Date('2026-11-14T10:00:00.000Z');
    await closeComputeInterval(db.executor, { clerkUserId: 'user_a', mode: 'full', openedAt: new Date(at.getTime() - HOUR), closedAt: at });
    await closeComputeInterval(db.executor, { clerkUserId: 'user_a', mode: 'export_only', openedAt: at, closedAt: new Date(at.getTime() + 600_000) });
    expect(await readComputeUsage(db.executor, 'user_a', new Date(at.getTime() + HOUR)))
      .toEqual({ billedMs: HOUR, exportMs: 600_000, exportWakes: 0 });
    expect(await readComputeUsage(db.executor, 'user_b', at)).toEqual({ billedMs: 0, exportMs: 0, exportWakes: 0 });
  });

  it('ignores an empty or inverted interval', async () => {
    const at = new Date('2026-11-14T10:00:00.000Z');
    await closeComputeInterval(db.executor, { clerkUserId: 'user_a', mode: 'full', openedAt: at, closedAt: new Date(at.getTime() - 1) });
    expect(await readComputeUsage(db.executor, 'user_a', at)).toEqual({ billedMs: 0, exportMs: 0, exportWakes: 0 });
  });
});
