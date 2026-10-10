import { describe, expect, it, vi } from 'vitest';
import {
  PLATFORM_STARTUP_CLEANUP_LIMIT,
  runPlatformStartupWithCleanup,
} from '../../packages/platform/src/platform-startup-cleanup.js';

describe('platform startup failure cleanup', () => {
  it('drains overlapping owned resources in reverse order even when ATS is disabled', async () => {
    const startupError = new Error('startup failed');
    const calls: string[] = [];
    let poolClosed = false;
    let mcpClosed = false;
    const closePool = async () => {
      if (poolClosed) return;
      poolClosed = true;
      calls.push('pool');
    };
    const closeMcp = async () => {
      if (mcpClosed) return;
      mcpClosed = true;
      calls.push('mcp');
      await closePool();
    };
    await expect(runPlatformStartupWithCleanup(async register => {
      register(closePool);
      register(closeMcp);
      register(async () => { calls.push('funded'); await closeMcp(); });
      register(async () => { calls.push('whatsapp'); });
      register(async () => { calls.push('account-deletion'); });
      register(async () => { /* ATS is disabled in a candidate process. */ });
      throw startupError;
    })).rejects.toBe(startupError);
    expect(calls).toEqual(['account-deletion', 'whatsapp', 'funded', 'mcp', 'pool']);
  });

  it('awaits an in-flight ATS drain before earlier dependencies close', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const failed = runPlatformStartupWithCleanup(async register => {
      register(async () => { calls.push('dependency'); });
      register(async () => { calls.push('ats-start'); await pending; calls.push('ats-end'); });
      throw new Error('startup failed');
    });
    await vi.waitFor(() => expect(calls).toEqual(['ats-start']));
    release();
    await expect(failed).rejects.toThrow('startup failed');
    expect(calls).toEqual(['ats-start', 'ats-end', 'dependency']);
  });

  it.each([new Error('private provider detail'), 'private provider detail'])('continues after a cleanup failure without replacing or exposing the startup error', async cleanupError => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startupError = new Error('original startup error');
    const remaining = vi.fn(async () => {});
    try {
      await expect(runPlatformStartupWithCleanup(async register => {
        register(remaining);
        register(async () => { throw cleanupError; });
        throw startupError;
      })).rejects.toBe(startupError);
      expect(remaining).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private provider detail');
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves successfully started resources to their normal shutdown owner', async () => {
    const close = vi.fn(async () => {});
    await runPlatformStartupWithCleanup(async register => { register(close); });
    expect(close).not.toHaveBeenCalled();
  });

  it('bounds registrations and drains retained callbacks when registration fails', async () => {
    const close = vi.fn(async () => {});
    await expect(runPlatformStartupWithCleanup(async register => {
      for (let index = 0; index <= PLATFORM_STARTUP_CLEANUP_LIMIT; index++) register(close);
    })).rejects.toThrow('Platform startup cleanup capacity exceeded');
    expect(close).toHaveBeenCalledTimes(PLATFORM_STARTUP_CLEANUP_LIMIT);
  });
});
