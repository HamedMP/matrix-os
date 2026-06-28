import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Rocket, Terminal } from 'lucide-react';
import Image from 'next/image';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import { DocsSidebarFooter } from '@/components/docs-sidebar-footer';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  const base = baseOptions();

  return (
    <RootProvider>
      <DocsLayout
        tree={source.getPageTree()}
        {...base}
        nav={{
          ...base.nav,
          title: (
            <>
              <Image
                src='/rabbit.svg'
                alt='Matrix OS'
                width={20}
                height={20}
                className='size-5 rounded dark:hidden'
              />
              <Image
                src='/rabbit-white.svg'
                alt='Matrix OS'
                width={20}
                height={20}
                className='hidden size-5 rounded dark:block'
              />
              <span className='font-medium max-md:hidden'>Matrix OS</span>
            </>
          ),
        }}
        themeSwitch={{
          enabled: false,
        }}
        sidebar={{
          footer: <DocsSidebarFooter />,
          // Explicit tabs override auto-generation from root folders and render
          // as the sidebar dropdown (fumadocs default). Users is the default tab
          // (flat pages at /docs root); Contributors is the scoped dev section.
          tabs: [
            {
              title: 'For Users',
              description: 'Use Matrix OS',
              url: '/docs',
              icon: <Rocket className='size-4' />,
            },
            {
              title: 'For Developers',
              description: 'Build & operate Matrix OS',
              url: '/docs/developer',
              icon: <Terminal className='size-4' />,
            },
          ],
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
