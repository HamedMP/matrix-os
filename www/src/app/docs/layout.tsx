import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';
import type { ReactNode } from 'react';

function getSection(path: string | undefined) {
  if (!path) return 'guide';
  const [dir] = path.split('/', 1);
  return dir === 'developer' ? 'developer' : 'guide';
}

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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src='/logo.png' alt='Matrix OS' className='size-5 rounded' />
              <span className='font-medium max-md:hidden'>Matrix OS</span>
            </>
          ),
        }}
        sidebar={{
          tabs: {
            transform(option, node) {
              const meta = source.getNodeMeta(node);
              if (!meta || !node.icon) return option;

              const color = `var(--${getSection(meta.path)}-color, var(--color-fd-foreground))`;

              return {
                ...option,
                icon: (
                  <div
                    className='[&_svg]:size-full rounded-lg size-full text-[var(--tab-color)] max-md:bg-[var(--tab-color)]/10 max-md:border max-md:p-1.5'
                    style={{ '--tab-color': color } as React.CSSProperties}
                  >
                    {node.icon}
                  </div>
                ),
              };
            },
          },
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
