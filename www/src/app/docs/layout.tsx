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
  return (
    <RootProvider>
      <DocsLayout
        tree={source.getPageTree()}
        {...baseOptions()}
        sidebar={{
          tabs: {
            transform(option, node) {
              const meta = source.getNodeMeta(node);
              if (!meta) return option;

              const color = `var(--${getSection(meta.path)}-color)`;

              return {
                ...option,
                icon: (
                  <div
                    className="rounded-lg p-1.5 [&_svg]:size-full text-[var(--tab-color)] border bg-[var(--tab-color)]/10"
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
