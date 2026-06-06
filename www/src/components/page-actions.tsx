'use client';
import { useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLinkIcon,
  Github,
  TextIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';
import { buttonVariants } from './ui/button-variants';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const CACHE_MAX_ENTRIES = 100;
const cache = new Map<string, string>();

function getCachedMarkdown(markdownUrl: string): string | undefined {
  const cached = cache.get(markdownUrl);
  if (cached === undefined) return undefined;

  // Refresh recency: insertion-order Map keeps the least-recently used key first.
  cache.delete(markdownUrl);
  cache.set(markdownUrl, cached);
  return cached;
}

function setCachedMarkdown(markdownUrl: string, content: string) {
  cache.set(markdownUrl, content);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function LLMCopyButton({
  /**
   * A URL to fetch the raw Markdown/MDX content of page
   */
  markdownUrl,
}: {
  markdownUrl: string;
}) {
  const [isLoading, setLoading] = useState(false);
  const [checked, onClick] = useCopyButton(async () => {
    const cached = getCachedMarkdown(markdownUrl);
    if (cached) return navigator.clipboard.writeText(cached);

    setLoading(true);

    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally without a catch clause; this is a compiler limitation, not a defect, and the try/finally is the correct shape for guaranteed loading-state reset.
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': fetch(markdownUrl).then(async (res) => {
            const content = await res.text();
            setCachedMarkdown(markdownUrl, content);

            return content;
          }),
        }),
      ]);
    } finally {
      setLoading(false);
    }
  });

  return (
    <button
      type="button"
      disabled={isLoading}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border border-fd-border bg-fd-muted/60 px-2.5 text-xs font-medium text-fd-foreground shadow-sm transition-colors hover:border-fd-primary/30 hover:bg-fd-card disabled:cursor-not-allowed disabled:opacity-60 dark:bg-fd-muted/50 dark:hover:bg-fd-accent',
      )}
      onClick={onClick}
    >
      {checked ? (
        <Check className="size-3.5 text-fd-primary" />
      ) : (
        <Copy className="size-3.5 text-fd-muted-foreground" />
      )}
      Copy Markdown
    </button>
  );
}

function GitHubIcon() {
  return <Github />;
}

export function ViewOptions({
  markdownUrl,
  githubUrl,
}: {
  /**
   * A URL to the raw Markdown/MDX content of page
   */
  markdownUrl: string;

  /**
   * Source file URL on GitHub
   */
  githubUrl: string;
}) {
  const pageUrl = typeof window !== 'undefined' ? window.location.href : 'loading';
  const q = `Read ${pageUrl}, I want to ask questions about it.`;

  const items = [
    {
      title: 'Open in GitHub',
      description: 'Read the source MDX file',
      href: githubUrl,
      icon: <GitHubIcon />,
    },
    {
      title: 'View as Markdown',
      description: 'Open the raw LLM-ready page',
      href: markdownUrl,
      icon: <TextIcon />,
    },
    {
      title: 'Open in Scira AI',
      description: 'Ask another AI about this page',
      href: `https://scira.ai/?${new URLSearchParams({
        q,
      })}`,
      icon: (
        <svg
          width="910"
          height="934"
          viewBox="0 0 910 934"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>Scira AI</title>
          <path
            d="M647.66 197.78C569.13 189.05 525.5 145.42 516.77 66.88C508.05 145.42 464.42 189.05 385.88 197.78C464.42 206.5 508.05 250.13 516.77 328.67C525.5 250.13 569.13 206.5 647.66 197.78Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <path
            d="M516.774 304.217C510.299 275.491 498.208 252.087 480.335 234.214C462.462 216.341 439.058 204.251 410.333 197.775C439.059 191.3 462.462 179.209 480.335 161.336C498.208 143.463 510.299 120.06 516.774 91.334C523.25 120.059 535.34 143.463 553.213 161.336C571.086 179.209 594.49 191.3 623.216 197.775C594.49 204.251 571.086 216.341 553.213 234.214C535.34 252.087 523.25 275.491 516.774 304.217Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <path
            d="M857.5 508.116C763.259 497.644 710.903 445.288 700.432 351.047C689.961 445.288 637.605 497.644 543.364 508.116C637.605 518.587 689.961 570.943 700.432 665.184C710.903 570.943 763.259 518.587 857.5 508.116Z"
            stroke="currentColor"
            strokeWidth="20"
            strokeLinejoin="round"
          />
          <path
            d="M700.432 615.957C691.848 589.05 678.575 566.357 660.383 548.165C642.191 529.973 619.499 516.7 592.593 508.116C619.499 499.533 642.191 486.258 660.383 468.066C678.575 449.874 691.848 427.181 700.432 400.274C709.015 427.181 722.289 449.874 740.481 468.066C758.673 486.258 781.365 499.533 808.271 508.116C781.365 516.7 758.673 529.973 740.481 548.165C722.289 566.357 709.015 589.05 700.432 615.957Z"
            stroke="currentColor"
            strokeWidth="20"
            strokeLinejoin="round"
          />
          <path
            d="M889.95 121.24C831.05 114.69 798.33 81.97 791.78 23.07C785.24 81.97 752.52 114.69 693.61 121.24C752.52 127.78 785.24 160.5 791.78 219.4C798.33 160.5 831.05 127.78 889.95 121.24Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <path
            d="M791.78 196.8C786.7 176.94 777.87 160.57 765.16 147.86C752.45 135.15 736.08 126.32 716.23 121.24C736.08 116.15 752.45 107.32 765.16 94.62C777.87 81.91 786.7 65.54 791.78 45.68C796.87 65.54 805.7 81.91 818.4 94.62C831.11 107.32 847.48 116.15 867.34 121.24C847.48 126.32 831.11 135.15 818.4 147.86C805.69 160.57 796.87 176.94 791.78 196.8Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <path
            d="M760.63 764.34C720.72 814.62 669.84 855.1 611.87 882.69C553.91 910.29 490.4 924.26 426.21 923.53C362.02 922.81 298.85 907.42 241.52 878.53C184.19 849.64 134.23 808.03 95.45 756.86C56.68 705.7 30.12 646.35 17.81 583.34C5.5 520.34 7.76 455.35 24.43 393.36C41.09 331.36 71.71 274 113.95 225.66C156.18 177.32 208.92 139.27 268.12 114.44"
            stroke="currentColor"
            strokeWidth="30"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      title: 'Open in ChatGPT',
      description: 'Start with this doc as context',
      href: `https://chatgpt.com/?${new URLSearchParams({
        hints: 'search',
        q,
      })}`,
      icon: (
        <svg
          role="img"
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>OpenAI</title>
          <path d="M22.28 9.82a5.98 5.98 0 0 0-0.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 0.74 7.1 5.98 5.98 0 0 0 0.51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-0.75-7.07zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l0.14-0.08 4.78-2.76a0.79 0.79 0 0 0 0.39-0.68v-6.74l2.02 1.17a0.07 0.07 0 0 1 0.04 0.05v5.58a4.5 4.5 0 0 1-4.49 4.49zm-9.66-4.13a4.47 4.47 0 0 1-0.53-3.01l0.14 0.09 4.78 2.76a0.77 0.77 0 0 0 0.78 0l5.84-3.37v2.33a0.08 0.08 0 0 1-0.03 0.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a0.77 0.77 0 0 0 0.39 0.68l5.81 3.35-2.02 1.17a0.08 0.08 0 0 1-0.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87zm16.6 3.86L13.1 8.36 15.12 7.2a0.08 0.08 0 0 1 0.07 0l4.83 2.79a4.49 4.49 0 0 1-0.68 8.1v-5.68a0.79 0.79 0 0 0-0.41-0.67zm2.01-3.02l-0.14-0.09-4.77-2.78a0.78 0.78 0 0 0-0.79 0L9.41 9.23V6.9a0.07 0.07 0 0 1 0.03-0.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a0.08 0.08 0 0 1-0.04-0.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-0.14 0.08L8.7 5.46a0.79 0.79 0 0 0-0.39 0.68zm1.1-2.37l2.6-1.5 2.61 1.5v3l-2.6 1.5-2.61-1.5Z" />
        </svg>
      ),
    },
    {
      title: 'Open in Claude',
      description: 'Discuss this page in Claude',
      href: `https://claude.ai/new?${new URLSearchParams({
        q,
      })}`,
      icon: (
        <svg
          fill="currentColor"
          role="img"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>Anthropic</title>
          <path d="M17.3 3.54h-3.67l6.7 16.92H24Zm-10.61 0L0 20.46h3.74l1.37-3.55h7.01l1.37 3.55h3.74L10.54 3.54Zm-0.37 10.22 2.29-5.95 2.29 5.95Z" />
        </svg>
      ),
    },
    {
      title: 'Open in Cursor',
      description: 'Send the doc prompt to Cursor',
      icon: (
        <svg
          fill="currentColor"
          role="img"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>Cursor</title>
          <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
        </svg>
      ),
      href: `https://cursor.com/link/prompt?${new URLSearchParams({
        text: q,
      })}`,
    },
  ];

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          buttonVariants({
            variant: 'secondary',
            size: 'sm',
            className:
              'h-8 gap-1.5 rounded-md border border-fd-border bg-fd-muted/60 px-2.5 text-xs font-medium text-fd-foreground shadow-sm transition-colors hover:border-fd-primary/30 hover:bg-fd-card dark:bg-fd-muted/50 dark:hover:bg-fd-accent',
          }),
        )}
      >
        <ExternalLinkIcon className="size-3.5 text-fd-muted-foreground" />
        Open with
        <ChevronDown className="size-3.5 text-fd-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-50 w-80 rounded-lg border-fd-border bg-fd-card/95 p-1.5 shadow-lg shadow-fd-primary/10 backdrop-blur"
      >
        <div className="px-2.5 pb-2 pt-2">
          <p className="text-xs font-semibold uppercase text-fd-muted-foreground">
            Page actions
          </p>
          <p className="mt-1 text-sm text-fd-muted-foreground">
            Use this doc in your editor, source control, or AI workspace.
          </p>
        </div>
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            rel="noreferrer noopener"
            target="_blank"
            className="group grid grid-cols-[1.25rem_1fr_auto] items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-fd-accent/80 hover:text-fd-accent-foreground"
          >
            <span className="grid size-5 place-items-center text-fd-muted-foreground transition-colors group-hover:text-fd-foreground [&_svg]:size-4">
              {item.icon}
            </span>
            <span>
              <span className="block font-medium leading-none">{item.title}</span>
              <span className="mt-1 block text-xs text-fd-muted-foreground">
                {item.description}
              </span>
            </span>
            <ExternalLinkIcon className="size-3.5 text-fd-muted-foreground" />
          </a>
        ))}
      </PopoverContent>
    </Popover>
  );
}
