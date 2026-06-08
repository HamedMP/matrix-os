'use client';

import Link from 'next/link';
import { useTheme } from 'next-themes';
import {
  BookOpen,
  ExternalLink,
  Github,
  Moon,
  Sparkles,
  Sun,
} from 'lucide-react';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      aria-hidden='true'
      className={className}
      fill='currentColor'
    >
      <path d='M19.54 5.23a16.5 16.5 0 0 0-4.06-1.28.06.06 0 0 0-.07.03c-.18.32-.38.74-.52 1.07a15.3 15.3 0 0 0-4.58 0 11.1 11.1 0 0 0-.53-1.07.07.07 0 0 0-.07-.03c-1.4.24-2.77.67-4.06 1.28a.06.06 0 0 0-.03.02C3.05 9.08 2.35 12.75 2.7 16.38c0 .02.01.04.03.05a16.6 16.6 0 0 0 4.98 2.52.07.07 0 0 0 .08-.03c.38-.52.72-1.07 1.02-1.65a.07.07 0 0 0-.04-.1 10.9 10.9 0 0 1-1.56-.74.07.07 0 0 1 0-.11l.31-.24a.06.06 0 0 1 .07 0c3.27 1.49 6.8 1.49 10.03 0a.06.06 0 0 1 .07 0l.32.24a.07.07 0 0 1 0 .11c-.5.3-1.02.55-1.57.74a.07.07 0 0 0-.04.1c.3.58.64 1.13 1.02 1.65a.07.07 0 0 0 .08.03 16.54 16.54 0 0 0 5-2.52.07.07 0 0 0 .03-.05c.42-4.2-.71-7.83-2.92-11.13a.05.05 0 0 0-.03-.02ZM8.52 14.17c-.98 0-1.8-.9-1.8-2s.8-2 1.8-2c1 0 1.82.9 1.8 2 0 1.1-.8 2-1.8 2Zm6.97 0c-.98 0-1.8-.9-1.8-2s.8-2 1.8-2c1 0 1.82.9 1.8 2 0 1.1-.79 2-1.8 2Z' />
    </svg>
  );
}

export function DocsSidebarFooter() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <div className='docs-sidebar-footer space-y-2 text-left'>
      <a
        href='https://discord.gg/cSBBQWtPwV'
        target='_blank'
        rel='noopener noreferrer'
        className='group block rounded-lg border border-[var(--ember)]/20 bg-white/70 p-2.5 text-left shadow-sm transition hover:border-[var(--ember)]/35 hover:bg-white dark:border-[var(--sage)]/20 dark:bg-[#101410] dark:hover:border-[var(--sage)]/35 dark:hover:bg-[#121812]'
      >
        <div className='flex items-start gap-2.5 text-left'>
          <span className='grid size-7 shrink-0 place-items-center rounded-md bg-[var(--forest)] text-white shadow-sm dark:bg-[var(--sage)] dark:text-[#101410]'>
            <DiscordIcon className='size-4' />
          </span>
          <span className='min-w-0 flex-1'>
            <span className='flex items-center gap-1.5 text-left text-sm font-semibold leading-tight text-fd-foreground'>
              Join Discord
              <ExternalLink className='size-3.5 text-fd-muted-foreground transition group-hover:text-[var(--ember)]' />
            </span>
            <span className='mt-1 block text-left text-xs leading-snug text-fd-muted-foreground'>
              Setup help, early builders, and product updates.
            </span>
          </span>
        </div>
      </a>

      <div className='grid gap-1.5 text-sm'>
        <a
          href='https://deepwiki.com/HamedMP/matrix-os/'
          target='_blank'
          rel='noopener noreferrer'
          className='flex items-center gap-2 rounded-lg px-2 py-1.5 text-fd-muted-foreground transition hover:bg-white/70 hover:text-fd-foreground dark:hover:bg-[var(--sage)]/10 dark:hover:text-fd-foreground'
        >
          <BookOpen className='size-4 shrink-0' />
          <span className='flex-1'>DeepWiki</span>
          <ExternalLink className='size-3.5 shrink-0' />
        </a>
        <Link
          href='/docs/users/matrix-skills'
          className='flex items-center gap-2 rounded-lg px-2 py-1.5 text-fd-muted-foreground transition hover:bg-white/70 hover:text-fd-foreground dark:hover:bg-[var(--sage)]/10 dark:hover:text-fd-foreground'
        >
          <Sparkles className='size-4 shrink-0' />
          <span>Matrix skills</span>
        </Link>
      </div>

      <div className='flex items-center justify-between pt-1 text-fd-muted-foreground'>
        <div className='flex items-center gap-1'>
          <a
            href='https://github.com/HamedMP/matrix-os'
            target='_blank'
            rel='noopener noreferrer'
            aria-label='GitHub'
            className='grid size-8 place-items-center rounded-lg transition hover:bg-white/70 hover:text-fd-foreground dark:hover:bg-[var(--sage)]/10 dark:hover:text-fd-foreground'
          >
            <Github className='size-4' />
          </a>
          <a
            href='https://deepwiki.com/HamedMP/matrix-os/'
            target='_blank'
            rel='noopener noreferrer'
            aria-label='DeepWiki'
            className='grid size-8 place-items-center rounded-lg transition hover:bg-white/70 hover:text-fd-foreground dark:hover:bg-[var(--sage)]/10 dark:hover:text-fd-foreground'
          >
            <BookOpen className='size-4' />
          </a>
          <a
            href='https://discord.gg/cSBBQWtPwV'
            target='_blank'
            rel='noopener noreferrer'
            aria-label='Discord'
            className='grid size-8 place-items-center rounded-lg transition hover:bg-white/70 hover:text-fd-foreground dark:hover:bg-[var(--sage)]/10 dark:hover:text-fd-foreground'
          >
            <DiscordIcon className='size-4' />
          </a>
        </div>
        <button
          type='button'
          aria-label='Toggle theme'
          title='Toggle theme'
          className='inline-flex items-center gap-1 rounded-full border border-fd-border bg-white p-1 text-fd-muted-foreground shadow-sm transition hover:text-fd-foreground dark:border-[var(--sage)]/20 dark:bg-[#101410]'
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          <span
            className={`grid size-6 place-items-center rounded-full ${
              isDark ? '' : 'bg-fd-muted text-fd-foreground'
            }`}
          >
            <Sun className='size-3.5' />
          </span>
          <span
            className={`grid size-6 place-items-center rounded-full ${
              isDark ? 'bg-fd-muted text-fd-foreground' : ''
            }`}
          >
            <Moon className='size-3.5' />
          </span>
        </button>
      </div>
    </div>
  );
}
